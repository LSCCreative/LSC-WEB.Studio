import AppKit
import SwiftUI

/// The menu-bar app: an icon that opens the publisher, a drop window that stays open
/// while files are dragged from Finder, and Settings. No Dock icon (LSUIElement).
@main
struct LSCPublisherApp: App {
    @State private var model = PublisherModel()

    init() {
        // Run straight from `swift run` (no Info.plist), it would get a Dock icon.
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            PublisherView(model: model, inMenu: true)
        } label: {
            Image(systemName: menuIcon)
        }
        .menuBarExtraStyle(.window)

        Window("LSC Publisher", id: "drop") {
            PublisherView(model: model, inMenu: false)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.topTrailing)

        Settings {
            SettingsView(model: model)
        }
    }

    private var menuIcon: String {
        switch model.job {
        case .running: return "arrow.up.circle.fill"
        case .done: return "checkmark.circle"
        case .failed: return "exclamationmark.triangle"
        default: return "arrow.up.circle"
        }
    }
}
