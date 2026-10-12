import SwiftUI
import AppKit
import WebKit
import PDFKit

struct AccountCard: View {
    let account: Account
    @ObservedObject var model: FlowModel
    var tint: Color { account.state == "ready" ? .mint : account.state == "blocked" ? .orange : .secondary }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("ACCOUNT \(account.name.uppercased())").font(.caption.weight(.bold)); Spacer(); Text(account.state == "ready" ? "Available" : account.state.capitalized).font(.caption).foregroundStyle(tint) }
            Text(account.email ?? "Connect account").font(.headline).lineLimit(1)
            Text((account.plan ?? "").uppercased()).font(.caption2).foregroundStyle(.secondary)
            ForEach(Array(account.windows.enumerated()), id: \.offset) { _, w in
                VStack(alignment: .leading, spacing: 5) {
                    HStack { Text(w.label); Spacer(); Text("\(Int(max(0,100-w.usedPercent)))% left") }.font(.caption)
                    ProgressView(value: max(0,min(100,100-w.usedPercent)), total: 100).tint(tint)
                    if let reset = w.resetsAt { Text("Resets \(Date(timeIntervalSince1970: reset).formatted(date: .abbreviated, time: .shortened))").font(.caption2).foregroundStyle(.secondary) }
                }
            }
            if let error = account.error { Text(error).font(.caption).foregroundStyle(.orange) }
            Button(account.email == nil ? "Sign in" : "Change account") { model.signIn(account.name) }.disabled(model.running || model.loginAccount != nil)
        }.padding(18).frame(maxWidth: .infinity, alignment: .topLeading).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
    }
}
struct Sidebar: View {
    @ObservedObject var model: FlowModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Image(systemName: "arrow.triangle.branch").foregroundStyle(.mint); Text("Codex Flow").font(.title3.weight(.semibold)) }.padding(.top, 12)
            HStack { Button { model.chooseProject() } label: { Label("Open project", systemImage: "folder") }; Button { model.createProject() } label: { Image(systemName: "folder.badge.plus") }.help("Create project") }.disabled(model.running || model.loginAccount != nil)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("PROJECTS").font(.caption2.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 8)
                    ForEach(model.library.recent, id: \.self) { path in
                        Button { model.openProject(path) } label: {
                            HStack { Image(systemName: "folder"); Text(URL(fileURLWithPath: path).lastPathComponent).lineLimit(1); Spacer() }.padding(7).background(model.project == path ? Color.mint.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 7))
                        }.buttonStyle(.plain).help(path).disabled(model.running || model.loginAccount != nil)
                    }
                    HStack { Text("CONVERSATIONS").font(.caption2.weight(.semibold)).foregroundStyle(.secondary); Spacer(); Button { model.newChat() } label: { Image(systemName: "square.and.pencil") }.buttonStyle(.plain).help("New conversation in this project").disabled(model.project.isEmpty || model.running || model.loginAccount != nil) }.padding(.top, 18)
                    ForEach(model.library.chats.filter { $0.project == model.project && $0.archived != true }) { chat in
                        Button { model.select(chat.id) } label: {
                            HStack(alignment: .top) { Image(systemName: "bubble.left"); Text(chat.title).lineLimit(2).multilineTextAlignment(.leading); Spacer() }.padding(9).background(model.library.selected == chat.id ? Color.white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).disabled(model.running || model.loginAccount != nil)
                          .contextMenu { Button("Rename…") { model.renameChat(chat.id) }; Button("Archive") { model.archiveChat(chat.id) } }
                    }
                    if model.library.chats.contains(where: { $0.project == model.project && $0.archived == true }) { Button("Restore archived conversations") { model.restoreChats() }.font(.caption).disabled(model.running) }
                }
            }
            Spacer(minLength: 0)
            Button { model.showAccounts = true; model.refresh() } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Image(systemName: "person.2"); Text("Accounts & usage"); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                    HStack {
                        ForEach(model.accounts) { a in
                            let left = a.windows.map { 100-$0.usedPercent }.min() ?? 0
                            HStack(spacing: 4) { Circle().fill(a.state == "ready" ? Color.mint : Color.orange).frame(width: 5,height: 5); Text("\(a.name.uppercased()) · \(a.state == "ready" ? "\(Int(left))%" : a.state)").font(.caption) }
                        }
                    }.foregroundStyle(.secondary)
                }.padding(12).background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
            }.buttonStyle(.plain)
            Text("Automatic account handoffs").font(.caption2).foregroundStyle(.secondary)
        }.padding(16).frame(width: 230).background(Color.black.opacity(0.16))
    }
}
final class ToolExpansion: ObservableObject { @Published var expanded = false }
struct MessageView: View {
    let message: ChatMessage
    @StateObject private var expansion = ToolExpansion()
    var body: some View {
        Group {
            if message.role == "tool" {
                DisclosureGroup(isExpanded: $expansion.expanded) {
                    if let detail = message.detail, !detail.isEmpty { Text(detail).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6) }
                } label: { Label(message.text, systemImage: "terminal").font(.system(size: 12, design: .monospaced)).lineLimit(expansion.expanded ? nil : 2).foregroundStyle(.secondary) }.padding(10).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
            } else if message.role == "notice" {
                Label(message.text, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(message.role == "user" ? "You" : "Codex").font(.caption.weight(.semibold)).foregroundStyle(message.role == "user" ? Color.secondary : Color.mint)
                        Spacer()
                        Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.text, forType: .string) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).foregroundStyle(.secondary).help("Copy message")
                    }
                    MarkdownMessage(text: message.text)
                    if let detail = message.detail { Label(detail, systemImage: "paperclip").font(.caption).foregroundStyle(.secondary) }
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(message.role == "user" ? Color.white.opacity(0.055) : .clear, in: RoundedRectangle(cornerRadius: 13))
            }
        }
    }
}
struct MarkdownMessage: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(text.components(separatedBy: "```").enumerated()), id: \.offset) { i, part in
                if i % 2 == 1 {
                    ScrollView(.horizontal) { Text(part).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(12) }.background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text((try? AttributedString(markdown: part, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(part)).font(.system(size: 14)).textSelection(.enabled).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
struct ConversationView: View {
    @ObservedObject var model: FlowModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.current?.title ?? "Your coding workspace").font(.headline).lineLimit(1)
                    Text(model.project.isEmpty ? "Open a project to begin" : model.project).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                if !model.project.isEmpty {
                    Button { NSWorkspace.shared.open(URL(fileURLWithPath: model.project)) } label: { Image(systemName: "folder") }.help("Open in Finder")
                    Button { model.openNotes() } label: { Image(systemName: "doc.text") }.help("Shared project notes")
                }
                Button { model.showInspector.toggle(); model.reloadFiles() } label: { Image(systemName: "sidebar.right") }.help("Files, changes and previews")
            }.padding(20)
            Divider().opacity(0.4)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if model.messages.isEmpty { emptyState }
                        ForEach(model.messages) { m in MessageView(message: m).id(m.id) }
                        if model.running { HStack(spacing: 8) { ProgressView().controlSize(.small); Text(model.activity).font(.caption).foregroundStyle(.secondary).lineLimit(2) }.padding(12) }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(20).frame(maxWidth: 900).frame(maxWidth: .infinity)
                }.onChange(of: model.messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }.onChange(of: model.library.selected) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            composer
        }.frame(minWidth: 470)
    }
    var emptyState: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "sparkles").font(.system(size: 28)).foregroundStyle(.mint)
            Text("What are we working on?").font(.system(size: 28, weight: .semibold))
            Text("Ask questions, plan a feature, or build it. Your conversation and project stay together when accounts switch.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.project.isEmpty { Button("Open a project") { model.chooseProject() }.buttonStyle(.borderedProminent).tint(.mint) }
            else {
                HStack { suggestion("Explain this project", mode: "ask"); suggestion("Plan the next feature", mode: "ask") }
            }
        }.padding(.vertical, 45).padding(.horizontal, 18)
    }
    func suggestion(_ text: String, mode: String) -> some View { Button(text) { model.mode = mode; model.request = text }.buttonStyle(.bordered) }
    var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let pending = model.current?.pendingTask, !model.running {
                HStack { Label("Unfinished request saved", systemImage: "clock.arrow.circlepath").font(.caption).help(pending); Spacer(); Button("Retry") { model.start(retry: true) }.disabled(model.loginAccount != nil) }.foregroundStyle(.orange)
            }
            HStack {
                Picker("Mode", selection: $model.mode) { Text("Ask").tag("ask"); Text("Build").tag("build") }.pickerStyle(.segmented).frame(width: 160).disabled(model.running)
                Text(model.mode == "ask" ? "Discuss and plan · read only" : "Edit project files and verify changes").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            TextEditor(text: $model.request).font(.system(size: 14)).scrollContentBackground(.hidden).padding(8).frame(height: 75).background(Color.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.10))).disabled(model.project.isEmpty)
            if !model.attachments.isEmpty {
                ScrollView(.horizontal) { HStack { ForEach(model.attachments, id: \.self) { path in HStack { Text(URL(fileURLWithPath: path).lastPathComponent); Button { model.attachments.removeAll { $0 == path } } label: { Image(systemName: "xmark") }.buttonStyle(.plain) }.font(.caption).padding(5).background(.white.opacity(0.06), in: Capsule()) } } }
            }
            HStack {
                Button { model.attach() } label: { Image(systemName: "paperclip") }.help("Attach reference files or images").disabled(model.running || model.project.isEmpty)
                Text(model.running ? "Account \((model.activeAccount ?? "…").uppercased())" : model.activity).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if model.running { Button(model.stopping ? "Stopping…" : "Stop") { model.stop() }.disabled(model.stopping) }
                else { Button { model.start() } label: { Label("Send", systemImage: "arrow.up") }.buttonStyle(.borderedProminent).tint(.mint).foregroundStyle(.black).keyboardShortcut(.return, modifiers: .command).disabled(model.project.isEmpty || model.request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.loginAccount != nil) }
            }
        }.padding(18).background(.white.opacity(0.025))
    }
}
struct FileInspector: View {
    @ObservedObject var model: FlowModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Picker("Inspect", selection: $model.inspector) { Text("Files").tag("Files"); Text("Changes").tag("Changes"); Text("Preview").tag("Preview") }.pickerStyle(.segmented); Button { model.reloadFiles(); if model.inspector == "Changes" { model.loadChanges() } } label: { Image(systemName: "arrow.clockwise") } }
            if model.inspector == "Files" { filesView }
            else if model.inspector == "Changes" {
                Text("Working tree · includes changes made outside Flow").font(.caption).foregroundStyle(.secondary)
                ScrollView([.vertical, .horizontal]) { Text(model.changes).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            } else { webPreview }
        }.padding(14).frame(minWidth: 300, idealWidth: 360, maxWidth: 500).background(Color.black.opacity(0.1)).onChange(of: model.inspector) { if model.inspector == "Changes" { model.loadChanges() } }
    }
    var filesView: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Find a project file", text: $model.fileFilter).textFieldStyle(.roundedBorder)
            List(selection: Binding<String?>(get: { model.selectedFile?.path }, set: { path in if let path { model.selectFile(URL(fileURLWithPath: path)) } })) {
                ForEach(model.files.filter { model.fileFilter.isEmpty || $0.relative.localizedCaseInsensitiveContains(model.fileFilter) }) { file in
                    Label(file.relative, systemImage: "doc").font(.system(size: 11, design: .monospaced)).lineLimit(1).help(file.relative).tag(file.url.path)
                }
            }.listStyle(.plain).frame(height: 170)
            Text("Up to 600 files · hidden and dependency folders excluded").font(.caption2).foregroundStyle(.secondary)
            Divider()
            if let url = model.selectedFile {
                HStack { Text(url.lastPathComponent).font(.caption.weight(.semibold)).lineLimit(1); Spacer(); Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "arrow.up.right.square") }.help("Open externally") }
                previewFile(url)
            } else { ContentUnavailableView("Select a file", systemImage: "doc.text.magnifyingglass", description: Text("View code, charts, images and PDFs here.")) }
            Spacer(minLength: 0)
        }
    }
    @ViewBuilder func previewFile(_ url: URL) -> some View {
        let ext = url.pathExtension.lowercased()
        if ["png", "jpg", "jpeg", "webp", "gif", "heic", "tiff"].contains(ext), let image = NSImage(contentsOf: url) { ScrollView { Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity) } }
        else if ext == "pdf" { PDFPreview(url: url) }
        else {
            if ["html", "htm", "svg"].contains(ext) { Button("Preview this document") { model.previewURL = url; model.inspector = "Preview" } }
            ScrollView([.vertical, .horizontal]) { Text(model.fileText).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        }
    }
    var webPreview: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { TextField("Website or localhost URL", text: $model.previewAddress).textFieldStyle(.roundedBorder).onSubmit { model.openPreview() }; Button("Go") { model.openPreview() } }
            Text("Open a running app or select an HTML/SVG file. Flow does not start a development server automatically.").font(.caption).foregroundStyle(.secondary)
            if let url = model.previewURL {
                HStack { Text(url.isFileURL ? url.lastPathComponent : url.absoluteString).font(.caption2).lineLimit(1); Spacer(); Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "safari") } }
                WebPreview(url: url, root: model.project).id(url.absoluteString)
            } else { ContentUnavailableView("Preview your work", systemImage: "globe", description: Text("Enter your app's local address, or preview an HTML/SVG file from Files.")) }
        }
    }
}
struct PDFPreview: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView { let v = PDFView(); v.autoScales = true; return v }
    func updateNSView(_ v: PDFView, context: Context) { if v.document?.documentURL != url { v.document = PDFDocument(url: url) } }
}
struct WebPreview: NSViewRepresentable {
    let url: URL; let root: String
    func makeNSView(context: Context) -> WKWebView { let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); return WKWebView(frame: .zero, configuration: config) }
    func updateNSView(_ v: WKWebView, context: Context) {
        if v.url == nil { if url.isFileURL { v.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: root)) } else { v.load(URLRequest(url: url)) } }
    }
}
struct ContentView: View {
    @StateObject var model = FlowModel.shared
    var body: some View {
        HStack(spacing: 0) {
            Sidebar(model: model)
            Divider().opacity(0.4)
            ConversationView(model: model)
            if model.showInspector { Divider().opacity(0.4); FileInspector(model: model) }
        }.frame(minWidth: model.showInspector ? 1100 : 780, minHeight: 700).background(Color(red: 0.055, green: 0.07, blue: 0.085)).preferredColorScheme(.dark)
            .sheet(isPresented: $model.showAccounts) { accountsSheet }
            .alert("Codex Flow", isPresented: Binding(get: { !model.alert.isEmpty }, set: { if !$0 { model.alert = "" } })) { Button("OK") { model.alert = "" } } message: { Text(model.alert) }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in model.stop(); model.cancelLogin() }
    }
    var accountsSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Accounts & usage").font(.title2.weight(.semibold)); Spacer(); Button("Refresh") { model.refresh() }.disabled(model.refreshing); Button("Done") { model.showAccounts = false } }
            HStack(alignment: .top, spacing: 12) { ForEach(model.accounts) { AccountCard(account: $0, model: model) } }
            if model.refreshing { ProgressView("Refreshing usage…") }
            if !model.statusError.isEmpty { Text(model.statusError).font(.caption).foregroundStyle(.orange) }
            if let recommended = model.accounts.first(where: { $0.recommended == true }), let reason = recommended.recommendationReason { Label(reason, systemImage: "sparkles").font(.caption).foregroundStyle(.mint).fixedSize(horizontal: false, vertical: true) }
            if !model.loginOutput.isEmpty { ScrollView { Text(model.loginOutput).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 100) }
            if model.loginAccount != nil { Button("Cancel sign-in") { model.cancelLogin() } }
            Text("Accounts switch behind the scenes. Conversations created here are saved locally; existing Codex desktop chats are separate.").font(.caption).foregroundStyle(.secondary)
        }.padding(24).frame(width: 720)
    }
}
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if !FlowModel.shared.running && FlowModel.shared.loginAccount == nil { return .terminateNow }
        let alert = NSAlert(); alert.messageText = "Close Codex Flow?"; alert.informativeText = "Active work will stop. Your conversation and project files are saved."; alert.addButton(withTitle: "Close"); alert.addButton(withTitle: "Keep open")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }
}
@main struct FlowApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        Window("Codex Flow", id: "main") { ContentView() }.windowStyle(.hiddenTitleBar).defaultSize(width: 1160, height: 820)
            .commands { CommandGroup(replacing: .newItem) { Button("New conversation") { FlowModel.shared.newChat() }.keyboardShortcut("n").disabled(FlowModel.shared.running); Button("Open project…") { FlowModel.shared.chooseProject() }.keyboardShortcut("o").disabled(FlowModel.shared.running) } }
    }
}
