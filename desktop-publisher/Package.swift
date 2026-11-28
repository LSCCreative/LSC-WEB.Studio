// swift-tools-version: 6.0
//
// LSC Publisher: the studio's menu-bar app for putting a file in front of a client
// (Bunny Slice 10). No third-party packages. `PublisherCore` holds everything that
// can be tested without a screen; `LSCPublisher` is the SwiftUI app on top of it.
import PackageDescription

let package = Package(
    name: "LSCPublisher",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "PublisherCore"),
        .executableTarget(name: "LSCPublisher", dependencies: ["PublisherCore"]),
        .testTarget(name: "PublisherCoreTests", dependencies: ["PublisherCore"]),
    ]
)
