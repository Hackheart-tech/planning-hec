import UIKit
import Capacitor
import AppIntents

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// =====================================================================
//  SIRI (App Intents) — Planning HEC
//  Raccourcis vocaux : "Quel est mon prochain rendez-vous", "Ajoute une
//  tâche", "Ajoute un rendez-vous". Ils lisent la session Supabase recopiée
//  par le web dans UserDefaults (clé "CapacitorStorage.sb_session") et
//  appellent directement l'API Supabase.
// =====================================================================

@available(iOS 16.0, *)
struct PlanningSession {
    let accessToken: String
    let refreshToken: String
    let userId: String
    let expiresAt: Double
}

@available(iOS 16.0, *)
enum PlanningAPI {
    static let baseURL = "https://qvzhpjmedoqgsopnidbt.supabase.co"
    static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2emhwam1lZG9xZ3NvcG5pZGJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNjQ4OTAsImV4cCI6MjEwMDY0MDg5MH0.64PreUlSl3YqkQYefF9sMg8Rn0-jP5yHZ4rnO_aHJGA"

    static func loadSession() -> PlanningSession? {
        guard let raw = UserDefaults.standard.string(forKey: "CapacitorStorage.sb_session"),
              let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let at = obj["access_token"] as? String,
              let uid = obj["user_id"] as? String else { return nil }
        let rt = obj["refresh_token"] as? String ?? ""
        var exp: Double = 0
        if let d = obj["expires_at"] as? Double { exp = d }
        else if let i = obj["expires_at"] as? Int { exp = Double(i) }
        return PlanningSession(accessToken: at, refreshToken: rt, userId: uid, expiresAt: exp)
    }

    // Renvoie un jeton valide (rafraîchi si expiré).
    static func validToken(_ s: PlanningSession) async -> String {
        let now = Date().timeIntervalSince1970
        if s.expiresAt > now + 30 || s.refreshToken.isEmpty { return s.accessToken }
        guard let url = URL(string: "\(baseURL)/auth/v1/token?grant_type=refresh_token") else { return s.accessToken }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(anonKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": s.refreshToken])
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let nt = obj["access_token"] as? String else { return s.accessToken }
        return nt
    }

    static func get(_ table: String, query: [URLQueryItem], token: String) async -> [[String: Any]]? {
        guard var comps = URLComponents(string: "\(baseURL)/rest/v1/\(table)") else { return nil }
        comps.queryItems = query
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.setValue(anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              ((resp as? HTTPURLResponse)?.statusCode ?? 500) < 300,
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        return arr
    }

    static func post(_ table: String, body: [String: Any], token: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/rest/v1/\(table)") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return ((resp as? HTTPURLResponse)?.statusCode ?? 500) < 300
    }

    // ISO UTC (pour écrire debut/fin)
    static func isoUTC(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return f.string(from: date)
    }

    // ISO Supabase -> texte français (Europe/Paris)
    static func frDate(_ iso: String) -> String {
        let formats = ["yyyy-MM-dd'T'HH:mm:ssZZZZZ", "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ", "yyyy-MM-dd'T'HH:mm:ss.SSSSSSZZZZZ"]
        let inFmt = DateFormatter()
        inFmt.locale = Locale(identifier: "en_US_POSIX")
        for f in formats {
            inFmt.dateFormat = f
            if let date = inFmt.date(from: iso) {
                let out = DateFormatter()
                out.locale = Locale(identifier: "fr_FR")
                out.timeZone = TimeZone(identifier: "Europe/Paris")
                out.dateFormat = "EEEE d MMMM 'à' HH'h'mm"
                return out.string(from: date)
            }
        }
        return iso
    }
}

// ---- Intent : mon prochain rendez-vous (lecture) ----
@available(iOS 16.0, *)
struct ProchainRdvIntent: AppIntent {
    static var title: LocalizedStringResource = "Mon prochain rendez-vous"
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let s = PlanningAPI.loadSession() else {
            return .result(dialog: "Connecte-toi d'abord dans Planning HEC.")
        }
        let token = await PlanningAPI.validToken(s)
        let nowISO = PlanningAPI.isoUTC(Date())
        let items = [
            URLQueryItem(name: "select", value: "titre,debut,lieu"),
            URLQueryItem(name: "assigne_a", value: "eq.\(s.userId)"),
            URLQueryItem(name: "type", value: "neq.bloc"),
            URLQueryItem(name: "statut", value: "neq.annule"),
            URLQueryItem(name: "debut", value: "gte.\(nowISO)"),
            URLQueryItem(name: "order", value: "debut.asc"),
            URLQueryItem(name: "limit", value: "1"),
        ]
        guard let rows = await PlanningAPI.get("agenda", query: items, token: token), let r = rows.first else {
            return .result(dialog: "Tu n'as aucun rendez-vous à venir.")
        }
        let titre = (r["titre"] as? String) ?? "rendez-vous"
        let quand = PlanningAPI.frDate((r["debut"] as? String) ?? "")
        var phrase = "Ton prochain rendez-vous : \(titre), \(quand)."
        if let lieu = r["lieu"] as? String, !lieu.isEmpty { phrase += " Lieu : \(lieu)." }
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

// ---- Intent : ajouter une tâche à faire ----
@available(iOS 16.0, *)
struct AjouterTacheIntent: AppIntent {
    static var title: LocalizedStringResource = "Ajouter une tâche à faire"
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Intitulé de la tâche")
    var texte: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ajouter la tâche \(\.$texte)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let s = PlanningAPI.loadSession() else {
            return .result(dialog: "Connecte-toi d'abord dans Planning HEC.")
        }
        let token = await PlanningAPI.validToken(s)
        let ok = await PlanningAPI.post("interventions",
            body: ["titre": texte, "urgence": "normale", "statut": "devis", "cree_par": s.userId],
            token: token)
        return .result(dialog: ok
            ? "C'est noté : « \(texte) » est ajouté aux tâches à faire."
            : "Je n'ai pas réussi à ajouter la tâche.")
    }
}

// ---- Intent : ajouter un rendez-vous personnel ----
@available(iOS 16.0, *)
struct AjouterRdvPersoIntent: AppIntent {
    static var title: LocalizedStringResource = "Ajouter un rendez-vous"
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Objet du rendez-vous")
    var texte: String

    @Parameter(title: "Date et heure")
    var date: Date

    static var parameterSummary: some ParameterSummary {
        Summary("Ajouter le rendez-vous \(\.$texte) le \(\.$date)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let s = PlanningAPI.loadSession() else {
            return .result(dialog: "Connecte-toi d'abord dans Planning HEC.")
        }
        let token = await PlanningAPI.validToken(s)
        let debut = PlanningAPI.isoUTC(date)
        let fin = PlanningAPI.isoUTC(date.addingTimeInterval(3600))
        let ok = await PlanningAPI.post("rdv",
            body: [
                "titre": texte, "type": "rdv", "prive": false,
                "assigne_a": s.userId, "cree_par": s.userId, "statut": "planifie",
                "debut": debut, "fin": fin,
            ],
            token: token)
        return .result(dialog: ok
            ? "Rendez-vous ajouté : « \(texte) », \(PlanningAPI.frDate(debut))."
            : "Je n'ai pas pu ajouter le rendez-vous (peut-être un créneau déjà occupé).")
    }
}

// ---- Déclaration des phrases Siri ----
@available(iOS 16.0, *)
struct PlanningShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        // RDV en PREMIER pour que Siri ne le confonde pas avec la tâche.
        AppShortcut(
            intent: AjouterRdvPersoIntent(),
            phrases: [
                "Ajoute un rendez-vous dans \(.applicationName)",
                "Nouveau rendez-vous dans \(.applicationName)",
                "Planifie un rendez-vous dans \(.applicationName)",
                "Crée un rendez-vous dans \(.applicationName)",
            ],
            shortTitle: "Ajouter un rendez-vous",
            systemImageName: "calendar.badge.plus"
        )
        AppShortcut(
            intent: ProchainRdvIntent(),
            phrases: [
                "Quel est mon prochain rendez-vous dans \(.applicationName)",
                "Mon prochain rendez-vous dans \(.applicationName)",
                "Prochain rendez-vous \(.applicationName)",
            ],
            shortTitle: "Prochain rendez-vous",
            systemImageName: "calendar"
        )
        // Tâche à faire : phrases SANS le mot "rendez-vous" pour éviter la confusion.
        AppShortcut(
            intent: AjouterTacheIntent(),
            phrases: [
                "Ajoute une tâche à faire dans \(.applicationName)",
                "Note une tâche dans \(.applicationName)",
                "Nouvelle tâche à faire dans \(.applicationName)",
            ],
            shortTitle: "Ajouter une tâche",
            systemImageName: "checklist"
        )
    }
}
