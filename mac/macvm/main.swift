// macvm: the Mac app's VM runner. Uses Apple's Virtualization framework to install and run
// macOS (Apple Silicon only) and Linux virtual machines, each in its own window.
//
//   macvm ipsw-url                                   prints "URL <newest macOS restore image>"
//   macvm install-macos <dir> --ipsw <file> --cpus N --memory MB --disk GB
//   macvm run <dir> --os macos|linux --name <title> --cpus N --memory MB --disk GB [--iso <file>]
//
// Output for the app, one line each: "PROGRESS <0..1> <text>", "ERROR <text>", "URL <url>".
// SIGTERM asks the guest to shut down (like pressing its power button).
import AppKit
import Foundation
import Virtualization

setvbuf(stdout, nil, _IOLBF, 0)

func say(_ line: String) {
    print(line)
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    say("ERROR \(message)")
    exit(1)
}

struct Failure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - Arguments

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else { fail("usage: macvm ipsw-url | install-macos <dir> … | run <dir> …") }
var positional: [String] = []
var flags: [String: String] = [:]
do {
    var i = 1
    while i < argv.count {
        if argv[i].hasPrefix("--"), i + 1 < argv.count {
            flags[String(argv[i].dropFirst(2))] = argv[i + 1]
            i += 2
        } else {
            positional.append(argv[i])
            i += 1
        }
    }
}

func intFlag(_ name: String, _ fallback: Int) -> Int { flags[name].flatMap { Int($0) } ?? fallback }

// MARK: - VM files (all inside the VM's folder)

struct VMFiles {
    let dir: URL
    var disk: URL { dir.appendingPathComponent("disk.img") }
    var auxiliary: URL { dir.appendingPathComponent("aux.img") }
    var hardwareModel: URL { dir.appendingPathComponent("hardware-model.bin") }
    var machineIdentifier: URL { dir.appendingPathComponent("machine-id.bin") }
    var efiVariables: URL { dir.appendingPathComponent("efi-vars.bin") }
}

func vmFiles() -> VMFiles {
    guard let dir = positional.first else { fail("Missing the VM folder.") }
    return VMFiles(dir: URL(fileURLWithPath: dir, isDirectory: true))
}

// A sparse disk file: it only takes up the space the VM actually uses. Grows when the VM's size is raised.
func prepareDisk(_ url: URL, gigabytes: Int) throws {
    let wanted = UInt64(gigabytes) << 30
    if !FileManager.default.fileExists(atPath: url.path) {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw Failure("Couldn't create the VM's disk at \(url.path).")
        }
    }
    let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.uint64Value ?? 0
    if wanted > size {
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: wanted)
        try handle.close()
    }
}

// MARK: - Configuration

func applyResources(_ config: VZVirtualMachineConfiguration, cpus: Int, memoryMB: Int) {
    config.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                          min(cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    config.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize,
                            min(UInt64(memoryMB) << 20, VZVirtualMachineConfiguration.maximumAllowedMemorySize))
}

func addCommonDevices(_ config: VZVirtualMachineConfiguration, disk: URL) throws {
    config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false))]

    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = VZNATNetworkDeviceAttachment()
    config.networkDevices = [network]

    let output = VZVirtioSoundDeviceOutputStreamConfiguration()
    output.sink = VZHostAudioOutputStreamSink()
    let sound = VZVirtioSoundDeviceConfiguration()
    sound.streams = [output]
    config.audioDevices = [sound]

    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
    config.keyboards = [VZUSBKeyboardConfiguration()]
}

func linuxConfiguration(_ files: VMFiles, cpus: Int, memoryMB: Int, diskGB: Int, iso: URL?) throws -> VZVirtualMachineConfiguration {
    try FileManager.default.createDirectory(at: files.dir, withIntermediateDirectories: true)
    let config = VZVirtualMachineConfiguration()

    let platform = VZGenericPlatformConfiguration()
    if let data = try? Data(contentsOf: files.machineIdentifier), let id = VZGenericMachineIdentifier(dataRepresentation: data) {
        platform.machineIdentifier = id
    } else {
        let id = VZGenericMachineIdentifier()
        try id.dataRepresentation.write(to: files.machineIdentifier)
        platform.machineIdentifier = id
    }
    config.platform = platform

    let boot = VZEFIBootLoader()
    boot.variableStore = FileManager.default.fileExists(atPath: files.efiVariables.path)
        ? VZEFIVariableStore(url: files.efiVariables)
        : try VZEFIVariableStore(creatingVariableStoreAt: files.efiVariables)
    config.bootLoader = boot

    applyResources(config, cpus: cpus, memoryMB: memoryMB)
    try prepareDisk(files.disk, gigabytes: diskGB)
    try addCommonDevices(config, disk: files.disk)
    if let iso {
        let disc = try VZDiskImageStorageDeviceAttachment(url: iso, readOnly: true)
        config.storageDevices.append(VZUSBMassStorageDeviceConfiguration(attachment: disc))
    }

    let graphics = VZVirtioGraphicsDeviceConfiguration()
    graphics.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: 1280, heightInPixels: 800)]
    config.graphicsDevices = [graphics]
    config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]

    // Copy and paste between the Mac and Linux (works once the guest has spice-vdagent, which most desktops include).
    let agent = VZSpiceAgentPortAttachment()
    agent.sharesClipboard = true
    let port = VZVirtioConsolePortConfiguration()
    port.name = VZSpiceAgentPortAttachment.spiceAgentPortName
    port.attachment = agent
    let console = VZVirtioConsoleDeviceConfiguration()
    console.ports[0] = port
    config.consoleDevices = [console]

    try config.validate()
    return config
}

#if arch(arm64)
func macPlatform(_ files: VMFiles) throws -> VZMacPlatformConfiguration {
    guard let modelData = try? Data(contentsOf: files.hardwareModel),
          let model = VZMacHardwareModel(dataRepresentation: modelData) else {
        throw Failure("This macOS VM isn't fully installed. Delete it and create it again.")
    }
    guard model.isSupported else { throw Failure("This Mac can't run the macOS version in this VM.") }
    guard let idData = try? Data(contentsOf: files.machineIdentifier),
          let id = VZMacMachineIdentifier(dataRepresentation: idData) else {
        throw Failure("This macOS VM's identity file is missing.")
    }
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = model
    platform.machineIdentifier = id
    platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: files.auxiliary)
    return platform
}

func macConfiguration(_ files: VMFiles, cpus: Int, memoryMB: Int) throws -> VZVirtualMachineConfiguration {
    let config = VZVirtualMachineConfiguration()
    config.platform = try macPlatform(files)
    config.bootLoader = VZMacOSBootLoader()
    applyResources(config, cpus: cpus, memoryMB: memoryMB)
    try addCommonDevices(config, disk: files.disk)

    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1200, pixelsPerInch: 80)]
    config.graphicsDevices = [graphics]
    config.pointingDevices = [VZMacTrackpadConfiguration(), VZUSBScreenCoordinatePointingDeviceConfiguration()]
    if #available(macOS 14.0, *) {
        config.keyboards = [VZMacKeyboardConfiguration()]
    }
    try config.validate()
    return config
}

// Kept alive for the whole install.
var installVM: VZVirtualMachine?
var installer: VZMacOSInstaller?
var installProgress: NSKeyValueObservation?

func installMacOS(_ files: VMFiles, ipsw: URL, cpus: Int, memoryMB: Int, diskGB: Int) {
    say("PROGRESS 0 Reading the macOS installer")
    VZMacOSRestoreImage.load(from: ipsw) { result in
        DispatchQueue.main.async {
            let image: VZMacOSRestoreImage
            switch result {
            case .failure(let error): fail("Couldn't read the macOS installer: \(error.localizedDescription)")
            case .success(let loaded): image = loaded
            }
            guard let requirements = image.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported else {
                fail("This Mac can't run macOS \(image.operatingSystemVersion.majorVersion) in a VM. Updating your Mac's macOS may help.")
            }
            do {
                try FileManager.default.createDirectory(at: files.dir, withIntermediateDirectories: true)
                try requirements.hardwareModel.dataRepresentation.write(to: files.hardwareModel)
                try VZMacMachineIdentifier().dataRepresentation.write(to: files.machineIdentifier)
                _ = try VZMacAuxiliaryStorage(creatingStorageAt: files.auxiliary, hardwareModel: requirements.hardwareModel, options: [.allowOverwrite])
                try? FileManager.default.removeItem(at: files.disk)
                try prepareDisk(files.disk, gigabytes: diskGB)

                let config = try macConfiguration(
                    files,
                    cpus: max(cpus, requirements.minimumSupportedCPUCount),
                    memoryMB: max(memoryMB, Int(requirements.minimumSupportedMemorySize >> 20)))
                let vm = VZVirtualMachine(configuration: config)
                let job = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: ipsw)
                installProgress = job.progress.observe(\.fractionCompleted, options: [.initial, .new]) { progress, _ in
                    say(String(format: "PROGRESS %.3f Installing macOS", progress.fractionCompleted))
                }
                installVM = vm
                installer = job
                job.install { result in
                    switch result {
                    case .success:
                        say("PROGRESS 1 macOS is installed")
                        exit(0)
                    case .failure(let error):
                        fail("The macOS install failed: \(error.localizedDescription)")
                    }
                }
            } catch {
                fail(error.localizedDescription)
            }
        }
    }
    dispatchMain()
}
#endif

// MARK: - The VM window

final class VMWindowController: NSObject, NSApplicationDelegate, NSWindowDelegate, VZVirtualMachineDelegate {
    let config: VZVirtualMachineConfiguration
    let title: String
    var vm: VZVirtualMachine!
    var window: NSWindow!
    var shutdownRequested = false

    init(config: VZVirtualMachineConfiguration, title: String) {
        self.config = config
        self.title = title
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        vm = VZVirtualMachine(configuration: config)
        vm.delegate = self

        let view = VZVirtualMachineView()
        view.virtualMachine = vm
        view.capturesSystemKeys = true
        if #available(macOS 14.0, *) {
            view.automaticallyReconfiguresDisplay = true
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = title
        window.contentView = view
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        vm.start { result in
            if case .failure(let error) = result { fail("The VM couldn't start: \(error.localizedDescription)") }
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let menu = NSMenu()
        menu.addItem(withTitle: "Shut Down \(title)", action: #selector(shutDown), keyEquivalent: "")
        menu.addItem(withTitle: "Force Stop \(title)", action: #selector(forceStop), keyEquivalent: "q")
        appItem.submenu = menu
        NSApp.mainMenu = main
    }

    // First close/stop asks the guest to shut down; doing it again pulls the plug.
    @objc func shutDown() {
        if !shutdownRequested, vm.state == .running, vm.canRequestStop {
            shutdownRequested = true
            try? vm.requestStop()
        } else {
            forceStop()
        }
    }

    @objc func forceStop() {
        guard vm.canStop else { exit(0) }
        vm.stop { _ in exit(0) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        shutDown()
        return false
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) { exit(0) }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fail("The VM stopped: \(error.localizedDescription)")
    }
}

func runWindow(_ config: VZVirtualMachineConfiguration) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let controller = VMWindowController(config: config, title: flags["name"] ?? "Virtual Machine")
    app.delegate = controller

    signal(SIGTERM, SIG_IGN)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminate.setEventHandler { controller.shutDown() }
    terminate.resume()

    app.run()
    withExtendedLifetime((controller, terminate)) {}
    exit(0)
}

// MARK: - Commands

switch command {
case "ipsw-url":
    #if arch(arm64)
    VZMacOSRestoreImage.fetchLatestSupported { result in
        switch result {
        case .success(let image):
            say("URL \(image.url.absoluteString)")
            exit(0)
        case .failure(let error):
            fail("Couldn't ask Apple for the latest macOS: \(error.localizedDescription)")
        }
    }
    dispatchMain()
    #else
    fail("macOS VMs need a Mac with Apple Silicon (M1 or newer).")
    #endif

case "install-macos":
    #if arch(arm64)
    guard let ipsw = flags["ipsw"] else { fail("Missing --ipsw.") }
    installMacOS(vmFiles(), ipsw: URL(fileURLWithPath: ipsw), cpus: intFlag("cpus", 4), memoryMB: intFlag("memory", 8192), diskGB: intFlag("disk", 80))
    #else
    fail("macOS VMs need a Mac with Apple Silicon (M1 or newer).")
    #endif

case "run":
    let files = vmFiles()
    do {
        if flags["os"] == "macos" {
            #if arch(arm64)
            runWindow(try macConfiguration(files, cpus: intFlag("cpus", 4), memoryMB: intFlag("memory", 8192)))
            #else
            fail("macOS VMs need a Mac with Apple Silicon (M1 or newer).")
            #endif
        } else {
            let iso = flags["iso"].map { URL(fileURLWithPath: $0) }
            runWindow(try linuxConfiguration(files, cpus: intFlag("cpus", 2), memoryMB: intFlag("memory", 4096), diskGB: intFlag("disk", 30), iso: iso))
        }
    } catch {
        fail(error.localizedDescription)
    }

default:
    fail("Unknown command \(command).")
}
