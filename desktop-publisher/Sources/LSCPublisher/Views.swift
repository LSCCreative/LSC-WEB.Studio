import PublisherCore
import SwiftUI

/// The whole publisher, shown in the menu-bar panel and in the drop window.
struct PublisherView: View {
    @Bindable var model: PublisherModel
    /// The menu-bar panel closes when Finder is clicked, so it points at the window.
    var inMenu: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            switch model.phase {
            case .starting:
                ProgressView().frame(maxWidth: .infinity, minHeight: 80)
            case .signedOut:
                SignInView(model: model)
            case .signedIn:
                TargetView(model: model)
                DropZone(model: model, inMenu: inMenu)
                JobView(model: model)
            }
            Divider()
            FooterView(model: model, inMenu: inMenu)
        }
        .padding(14)
        .frame(width: 360)
    }

    private var header: some View {
        HStack {
            Image(systemName: "arrow.up.circle.fill").foregroundStyle(.tint)
            Text("LSC Publisher").font(.headline)
            Spacer()
            if model.phase == .signedIn {
                Text(model.username).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct SignInView: View {
    let model: PublisherModel
    @State private var user = ""
    // Only here, and cleared once it's sent: the password is never kept.
    @State private var password = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sign in with the admin’s account.").font(.callout).foregroundStyle(.secondary)
            TextField("Username or email", text: $user)
                .textContentType(.username)
            SecureField("Password", text: $password)
                .textContentType(.password)
                .onSubmit(send)
            if let error = model.signInError {
                Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(action: send) {
                    if model.signingIn { ProgressView().controlSize(.small) } else { Text("Sign In") }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(user.isEmpty || password.isEmpty || model.signingIn)
            }
        }
        .textFieldStyle(.roundedBorder)
    }

    private func send() {
        guard !user.isEmpty, !password.isEmpty else { return }
        let typed = password
        password = ""
        Task { await model.signIn(user: user, password: typed) }
    }
}

struct TargetView: View {
    @Bindable var model: PublisherModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Project", selection: Binding(
                    get: { model.selectedProjectId },
                    set: { id in Task { await model.selectProject(id) } }
                )) {
                    Text("Choose…").tag(String?.none)
                    ForEach(model.projects) { p in Text(p.label).tag(String?.some(p.id)) }
                }
                .disabled(model.isLocked)
                Button {
                    Task { await model.loadProjects() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Reload the projects")
                .disabled(model.loadingProjects || model.isLocked)
            }
            if model.loadingProjects {
                Text("Loading projects…").font(.caption).foregroundStyle(.secondary)
            } else if model.projects.isEmpty {
                Text("No projects are in production or review.").font(.caption).foregroundStyle(.secondary)
            }

            if model.selectedProjectId != nil {
                if model.loadingFolder && model.folder == nil {
                    ProgressView().controlSize(.small)
                } else if model.items.isEmpty {
                    Text("This project has no deliverables to add to. Add them on its Deliverables tab.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                } else {
                    Picker("Deliverable", selection: Binding(
                        get: { model.selectedItemId },
                        set: { model.selectItem($0) }
                    )) {
                        ForEach(model.items) { item in
                            Text(itemLabel(item)).tag(String?.some(item.id))
                        }
                    }
                    .disabled(model.isLocked)
                    destinationRow
                }
            }
            if let error = model.listError {
                Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func itemLabel(_ item: Deliverable) -> String {
        "\(item.title) · v\((item.newest?.n ?? 0) + 1) \(item.stageLabel)"
    }

    private var destinationRow: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("NAS folder").foregroundStyle(.secondary)
            Text(model.destination ?? "Not chosen")
                .lineLimit(1).truncationMode(.middle)
                .foregroundStyle(model.destination == nil ? .orange : .primary)
                .help(model.destination ?? "Files from elsewhere are copied here first.")
            Spacer()
            Button("Change…") { model.chooseDestination() }
                .disabled(!model.shareConnected || model.isLocked)
                .help(model.shareConnected ? "Choose where new files are copied on the NAS." : "Connect to the NAS share in Finder first.")
        }
        .font(.callout)
    }
}

struct DropZone: View {
    let model: PublisherModel
    var inMenu: Bool
    @State private var targeted = false

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "square.and.arrow.down.on.square").font(.title2)
            Text(inMenu ? "Drop a video or photo folder here" : "Drop a video or a photo folder")
                .font(.callout)
            Button("Choose…") { model.chooseFile() }
                .buttonStyle(.link)
                .disabled(model.isBusy)
        }
        .frame(maxWidth: .infinity, minHeight: 96)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                .foregroundStyle(targeted ? Color.accentColor : Color.secondary.opacity(0.5))
        )
        .background(RoundedRectangle(cornerRadius: 10).fill(targeted ? Color.accentColor.opacity(0.08) : .clear))
        .opacity(model.selectedItem == nil || model.isBusy ? 0.5 : 1)
        .dropDestination(for: URL.self) { urls, _ in
            model.drop(urls)
        } isTargeted: { targeted = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Drop zone. Drop a video or a photo folder to publish it.")
    }
}

struct JobView: View {
    let model: PublisherModel

    var body: some View {
        switch model.job {
        case .none:
            EmptyView()
        case .checking(let source):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Checking “\(source.lastPathComponent)”…").font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Cancel") { model.cancel() }.controlSize(.small)
            }
        case .confirming(let pending):
            confirmCard(pending)
        case .running(let source, let step):
            VStack(alignment: .leading, spacing: 6) {
                Text(source.lastPathComponent).font(.callout.bold()).lineLimit(1).truncationMode(.middle)
                if let fraction = step.fraction {
                    ProgressView(value: fraction)
                } else {
                    ProgressView().progressViewStyle(.linear)
                }
                HStack {
                    Text(step.label).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Stop") { model.cancel() }.controlSize(.small)
                }
            }
        case .done(let outcome):
            VStack(alignment: .leading, spacing: 6) {
                Label("v\(outcome.versionN) of “\(outcome.itemTitle)” is with the client.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green).font(.callout)
                Text(doneDetail(outcome)).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack { Spacer(); Button("OK") { model.dismiss() }.controlSize(.small) }
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 6) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red).font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                HStack { Spacer(); Button("OK") { model.dismiss() }.controlSize(.small) }
            }
        }
    }

    private func confirmCard(_ pending: PublisherModel.Pending) -> some View {
        let item = pending.item
        let what: String = {
            if case .photos(let count) = pending.kind { return "\(count) photo\(count == 1 ? "" : "s")" }
            return "the video"
        }()
        let route = pending.onShare
            ? "It’s already on the NAS, so nothing is copied."
            : "It’s copied to \(pending.destination ?? "the project’s folder") on the NAS first."
        let bunny = pending.bunnyOn
            ? " Bunny gets \(what), and the client sees it once Bunny has it ready."
            : " The client sees it from the NAS."
        return VStack(alignment: .leading, spacing: 8) {
            Text("Publish v\(pending.nextN) of “\(item.title)”?").font(.callout.bold())
            Text("“\(pending.source.lastPathComponent)” becomes the \(item.stageLabel) the client reviews. \(route)\(bunny) A published version can’t be changed, only followed by a new one.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { model.cancel() }.keyboardShortcut(.cancelAction)
                Button("Publish") { model.confirm() }.keyboardShortcut(.defaultAction)
            }
            .controlSize(.small)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    private func doneDetail(_ outcome: PublishOutcome) -> String {
        var lines = ["\(outcome.fileName) went out as the \(outcome.stageLabel)."]
        if let copied = outcome.copiedTo { lines.append("Copied to \(copied) on the NAS.") }
        if let why = outcome.bunnyProblem {
            lines.append("Bunny couldn’t take the photos (\(why)), so the client sees them from the NAS for now. Send them to Bunny again from the Deliverables tab.")
        }
        if outcome.firstPublish {
            lines.append("It’s this project’s first publish, and no invite email went out. Send it from the Deliverables tab when you’re ready.")
        }
        return lines.joined(separator: " ")
    }
}

struct FooterView: View {
    let model: PublisherModel
    var inMenu: Bool
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 12) {
            if inMenu {
                Button("Drop window") {
                    openWindow(id: "drop")
                    NSApp.activate(ignoringOtherApps: true)
                }
                .help("A window that stays open while you drag from Finder")
            }
            SettingsLink { Text("Settings…") }
            Spacer()
            if model.phase == .signedIn {
                Button("Sign out") { Task { await model.signOut() } }
            }
            if inMenu {
                Button("Quit") { model.quit() }
            }
        }
        .buttonStyle(.link)
        .font(.caption)
    }
}

struct SettingsView: View {
    @Bindable var model: PublisherModel

    var body: some View {
        Form {
            Section {
                TextField("Server", text: $model.serverURL, prompt: Text(PublisherModel.defaultServer))
                Text(model.serverBase == nil
                     ? "Needs to start with https:// (http:// only for localhost)."
                     : "The admin’s address. Sign out and in again after changing it.")
                    .font(.caption).foregroundStyle(model.serverBase == nil ? .red : .secondary)
            }
            Section {
                HStack {
                    TextField("NAS deliverables folder", text: $model.shareRoot)
                    Button("Choose…") { chooseShare() }
                }
                Text(model.shareConnected
                     ? "Connected. This is “Client Deliverables_Media” as this Mac mounts it."
                     : "Not connected. Connect to the NAS in Finder (Go ▸ Connect to Server), then choose “Client Deliverables_Media”.")
                    .font(.caption).foregroundStyle(model.shareConnected ? Color.secondary : Color.orange)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding(.vertical, 8)
    }

    private func chooseShare() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose “Client Deliverables_Media” on the NAS share."
        panel.directoryURL = URL(fileURLWithPath: "/Volumes", isDirectory: true)
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let url = panel.url { model.shareRoot = url.path }
    }
}
