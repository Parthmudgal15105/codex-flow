import SwiftUI
import AppKit

struct UsageWindow: Decodable {
    let usedPercent: Double
    let windowDurationMins: Double?
    let resetsAt: Double?
    let bucket: String?
    var label: String { guard let m = windowDurationMins else { return "Allowance" }; return m >= 1440 ? "\(Int(m / 1440)) day allowance" : "\(Int(m / 60)) hour allowance" }
}
struct Account: Decodable, Identifiable {
    let name: String; let email: String?; let plan: String?; let state: String
    let windows: [UsageWindow]; let error: String?
    var recommended: Bool? = nil; var recommendationReason: String? = nil
    var id: String { name }
}
struct ChatMessage: Codable, Identifiable {
    var id = UUID().uuidString
    var role: String
    var text: String
    var detail: String? = nil
    var account: String? = nil
}
struct ChatSession: Codable, Identifiable {
    var id = UUID().uuidString
    var title = "New conversation"
    var project: String
    var messages: [ChatMessage] = []
    var draft: String? = nil
    var archived: Bool? = nil
    var pendingTask: String? = nil
    var pendingMode: String? = nil
    var pendingAttachments: [String]? = nil
}
struct Library: Codable { var chats: [ChatSession] = []; var recent: [String] = []; var selected: String? = nil }
struct ProjectFile: Identifiable { let url: URL; let relative: String; var id: String { url.path } }
final class FlowModel: ObservableObject {
    static let shared = FlowModel()
    @Published var accounts: [Account] = []
    @Published var refreshing = false
    @Published var statusError = ""
    @Published var library = Library()
    @Published var request = "" { didSet { mutate { $0.draft = request } } }
    @Published var mode = UserDefaults.standard.string(forKey: "flowMode") ?? "ask" { didSet { UserDefaults.standard.set(mode, forKey: "flowMode") } }
    @Published var attachments: [String] = []
    @Published var running = false
    @Published var stopping = false
    @Published var activity = "Ready when you are"
    @Published var activeAccount: String? = nil
    @Published var loginAccount: String? = nil
    @Published var loginOutput = ""
    @Published var files: [ProjectFile] = []
    @Published var selectedFile: URL? = nil
    @Published var fileText = ""
    @Published var fileFilter = ""
    @Published var changes = "Choose a project to inspect changes."
    @Published var inspector = "Files"
    @Published var showInspector = false
    @Published var showAccounts = false
    @Published var previewAddress = "http://localhost:3000"
    @Published var previewURL: URL? = nil
    @Published var alert = ""
    private var worker: Process?
    private var login: Process?
    private var timer: Timer?
    let node = Bundle.main.object(forInfoDictionaryKey: "FlowNodeExecutable") as? String ?? "/opt/homebrew/bin/node"
    let cli = Bundle.main.object(forInfoDictionaryKey: "FlowCLIPath") as? String ?? ""
    let dataURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex-flow/ui/library.json")
    var current: ChatSession? { library.chats.first { $0.id == library.selected } }
    var project: String { current?.project ?? "" }
    var messages: [ChatMessage] { current?.messages ?? [] }
    init() {
        if let data = try? Data(contentsOf: dataURL), let saved = try? JSONDecoder().decode(Library.self, from: data) { library = saved }
        if library.chats.isEmpty, let old = UserDefaults.standard.string(forKey: "projectPath"), !old.isEmpty { newChat(project: old) }
        request = current?.draft ?? ""
        reloadFiles(); refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
    }
    func persist() {
        do {
            try FileManager.default.createDirectory(at: dataURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(library).write(to: dataURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dataURL.path)
        } catch { alert = "Could not save conversation: \(error.localizedDescription)" }
    }
    func mutate(_ change: (inout ChatSession) -> Void) {
        guard let i = library.chats.firstIndex(where: { $0.id == library.selected }) else { return }
        change(&library.chats[i]); persist()
    }
    func append(_ message: ChatMessage) { mutate { $0.messages.append(message) } }
    func select(_ id: String) {
        guard !running && loginAccount == nil else { return }
        library.selected = id; request = current?.draft ?? ""; attachments = []; activeAccount = nil; activity = "Ready when you are"; selectedFile = nil; previewURL = nil
        persist(); reloadFiles(); refresh()
    }
    func newChat(project path: String? = nil) {
        guard !running && loginAccount == nil else { return }
        let path = path ?? project
        guard !path.isEmpty else { chooseProject(); return }
        let chat = ChatSession(project: path)
        library.chats.insert(chat, at: 0); library.selected = chat.id
        library.recent.removeAll { $0 == path }; library.recent.insert(path, at: 0)
        request = ""; attachments = []; selectedFile = nil; previewURL = nil; activeAccount = nil; activity = "Ready when you are"
        persist(); reloadFiles(); refresh()
    }
    func renameChat(_ id: String) {
        guard !running, let i = library.chats.firstIndex(where: { $0.id == id }) else { return }
        let dialog = NSAlert(); dialog.messageText = "Rename conversation"; dialog.addButton(withTitle: "Save"); dialog.addButton(withTitle: "Cancel")
        let field = NSTextField(string: library.chats[i].title); field.frame = NSRect(x: 0, y: 0, width: 320, height: 24); dialog.accessoryView = field
        if dialog.runModal() == .alertFirstButtonReturn && !field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { library.chats[i].title = field.stringValue; persist() }
    }
    func archiveChat(_ id: String) {
        guard !running, let i = library.chats.firstIndex(where: { $0.id == id }) else { return }
        library.chats[i].archived = true; persist()
        if library.selected == id { newChat(project: library.chats[i].project) }
    }
    func restoreChats() { for i in library.chats.indices where library.chats[i].project == project { library.chats[i].archived = false }; persist() }
    func chooseProject() {
        let picker = NSOpenPanel(); picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.prompt = "Open project"
        if picker.runModal() == .OK, let url = picker.url { openProject(url.path) }
    }
    func openProject(_ path: String) {
        guard !running && loginAccount == nil else { return }
        if let chat = library.chats.first(where: { $0.project == path && $0.archived != true }) { select(chat.id) }
        else { newChat(project: path) }
    }
    func createProject() {
        let panel = NSSavePanel(); panel.title = "Create project folder"; panel.prompt = "Create"; panel.nameFieldStringValue = "My Project"; panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["init", url.path]; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice; try p.run(); p.waitUntilExit()
            guard p.terminationStatus == 0 else { alert = "Could not initialize this project with Git."; return }
            newChat(project: url.path)
        } catch { alert = error.localizedDescription }
    }
    func process(_ args: [String]) -> Process {
        let p = Process(); p.executableURL = URL(fileURLWithPath: node); p.arguments = [cli] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        env["CODEX_FLOW_CODEX"] = Bundle.main.object(forInfoDictionaryKey: "FlowCodexExecutable") as? String ?? "codex"
        p.environment = env; p.standardInput = FileHandle.nullDevice
        return p
    }
    func refresh() {
        guard !refreshing else { return }; refreshing = true
        let p = process(["status", "--json"] + (project.isEmpty ? [] : ["--project", project, "--chat", current?.id ?? "default"]))
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        DispatchQueue.global().async {
            do {
                try p.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
                let result = try JSONDecoder().decode([Account].self, from: data)
                DispatchQueue.main.async { self.accounts = result; self.refreshing = false; self.statusError = "" }
            } catch { DispatchQueue.main.async { self.refreshing = false; self.statusError = "Could not refresh usage: \(error.localizedDescription)" } }
        }
    }
    func start(retry: Bool = false) {
        guard !running, loginAccount == nil, let chat = current else { return }
        let task = retry ? chat.pendingTask ?? "" : request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return }
        let taskMode = retry ? chat.pendingMode ?? "build" : mode
        let paths = retry ? chat.pendingAttachments ?? [] : attachments
        let payload: [String: Any] = ["project": chat.project, "chat": chat.id, "task": task, "mode": taskMode, "attachments": paths, "retry": retry]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        if !retry { append(ChatMessage(role: "user", text: task, detail: paths.isEmpty ? nil : paths.map { URL(fileURLWithPath: $0).lastPathComponent }.joined(separator: ", "))); mutate { if $0.title == "New conversation" { $0.title = String(task.prefix(55)) } } }
        mutate { $0.pendingTask = task; $0.pendingMode = taskMode; $0.pendingAttachments = paths }
        request = ""; attachments = []; running = true; stopping = false; activity = "Finding the best available account…"
        let p = process(["ui-run"]), out = Pipe(), err = Pipe(), input = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = input; worker = p
        err.fileHandleForReading.readabilityHandler = { h in
            let bytes = h.availableData
            if !bytes.isEmpty { DispatchQueue.main.async { self.append(ChatMessage(role: "tool", text: "Codex diagnostic", detail: String(decoding: bytes, as: UTF8.self))) } }
        }
        DispatchQueue.global().async {
            do {
                try p.run(); input.fileHandleForWriting.write(data); try? input.fileHandleForWriting.close()
                var buffer = Data()
                while true {
                    let bytes = out.fileHandleForReading.availableData
                    if bytes.isEmpty { break }; buffer.append(bytes)
                    while let newline = buffer.firstIndex(of: 10) {
                        let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                        if let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                            DispatchQueue.main.async { self.consume(event) }
                        }
                    }
                }
                p.waitUntilExit(); err.fileHandleForReading.readabilityHandler = nil
                DispatchQueue.main.async {
                    self.worker = nil; self.running = false
                    if self.stopping { self.activity = "Stopped · conversation saved" }
                    else if p.terminationStatus != 0 && !self.activity.contains("unavailable") { self.activity = "Request stopped · use Retry to continue" }
                    self.stopping = false; self.reloadFiles(); self.refresh()
                }
            } catch { DispatchQueue.main.async { self.worker = nil; self.running = false; self.activity = "Could not start"; self.append(ChatMessage(role: "notice", text: error.localizedDescription)) } }
        }
    }
    func consume(_ event: [String: Any]) {
        let type = event["type"] as? String ?? "", text = event["text"] as? String ?? ""
        switch type {
        case "message": append(ChatMessage(role: "assistant", text: text, account: event["account"] as? String))
        case "tool": append(ChatMessage(role: "tool", text: text, detail: String((event["detail"] as? String ?? "").prefix(60000))))
        case "changes":
            let paths = (event["changes"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }.joined(separator: "\n")
            append(ChatMessage(role: "tool", text: text, detail: paths)); reloadFiles()
        case "handoff", "notice", "failed", "unavailable", "stopped": activity = text; append(ChatMessage(role: "notice", text: text))
        case "account": activeAccount = event["name"] as? String; activity = text
        case "status": activity = text
        case "done": activity = text; mutate { $0.pendingTask = nil; $0.pendingMode = nil; $0.pendingAttachments = nil }
        case "diagnostic": break // Raw harness diagnostics are not conversation replies.
        default: break
        }
    }
    func stop() { guard let worker else { return }; stopping = true; activity = "Stopping safely…"; worker.interrupt() }
    func signIn(_ name: String) {
        guard !running, loginAccount == nil else { return }; loginAccount = name; loginOutput = "Complete sign-in in your browser.\n"
        let p = process(["login", name]), pipe = Pipe(); login = p; p.standardOutput = pipe; p.standardError = pipe
        DispatchQueue.global().async {
            do {
                try p.run()
                while true { let bytes = pipe.fileHandleForReading.availableData; if bytes.isEmpty { break }; DispatchQueue.main.async { self.loginOutput += String(decoding: bytes, as: UTF8.self) } }
                p.waitUntilExit(); DispatchQueue.main.async { self.login = nil; self.loginAccount = nil; self.loginOutput += p.terminationStatus == 0 ? "\nSigned in." : "\nSign-in stopped."; self.refresh() }
            } catch { DispatchQueue.main.async { self.loginAccount = nil; self.login = nil; self.loginOutput = error.localizedDescription } }
        }
    }
    func cancelLogin() { login?.interrupt() }
    func attach() {
        let picker = NSOpenPanel(); picker.allowsMultipleSelection = true; picker.prompt = "Attach references"
        if picker.runModal() == .OK { attachments = Array(Set(attachments + picker.urls.map(\.path))).sorted() }
    }
    func reloadFiles() {
        guard !project.isEmpty else { files = []; return }
        let root = URL(fileURLWithPath: project)
        let ignore: Set<String> = [".git", "node_modules", ".next", ".venv", "venv", "__pycache__", "build", "DerivedData"]
        var result: [ProjectFile] = []
        if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
            for case let url as URL in e {
                if ignore.contains(url.lastPathComponent) { e.skipDescendants(); continue }
                let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                if values?.isSymbolicLink == true { e.skipDescendants(); continue }
                if values?.isRegularFile == true { result.append(ProjectFile(url: url, relative: String(url.path.dropFirst(root.path.count + 1)))) }
                if result.count >= 600 { break }
            }
        }
        files = result.sorted { $0.relative < $1.relative }
        if inspector == "Changes" { loadChanges() }
        if let selectedFile { selectFile(selectedFile) }
    }
    func selectFile(_ url: URL) {
        selectedFile = url
        if let data = try? FileHandle(forReadingFrom: url) {
            defer { try? data.close() }
            let bytes = (try? data.read(upToCount: 250000)) ?? Data()
            fileText = String(data: bytes, encoding: .utf8) ?? "This file is binary. Use Open externally to view it."
            if bytes.count >= 250000 { fileText += "\n\n[Preview limited to 250 KB]" }
        } else { fileText = "This file could not be read." }
    }
    func loadChanges() {
        guard !project.isEmpty else { return }; let cwd = project; changes = "Reading Git changes…"
        DispatchQueue.global().async {
            var text = ""
            for args in [["status", "--short", "--untracked-files=all"], ["diff", "--stat"], ["diff", "--no-ext-diff", "--no-color"], ["diff", "--cached", "--no-ext-diff", "--no-color"]] {
                let p = Process(), pipe = Pipe(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["--no-pager", "-C", cwd] + args + ["--", "."]; p.standardOutput = pipe; p.standardError = pipe
                do { try p.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit(); text += "$ git \(args.joined(separator: " "))\n" + String(decoding: data.prefix(250000), as: UTF8.self) + "\n" }
                catch { text += error.localizedDescription }
            }
            DispatchQueue.main.async { if self.project == cwd { self.changes = text } }
        }
    }
    func openPreview() {
        guard let url = URL(string: previewAddress), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { alert = "Enter a complete http:// or https:// address."; return }
        previewURL = url
    }
    func openNotes() {
        let url = URL(fileURLWithPath: project).appendingPathComponent("implementation.md")
        guard FileManager.default.fileExists(atPath: url.path) else { alert = "Project notes will appear after your first Build request. Ask mode leaves files untouched."; return }
        selectedFile = url; selectFile(url); showInspector = true; inspector = "Files"
    }
}
