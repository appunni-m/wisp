pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
    }
}

rootProject.name = "wisp"

// The wire format, in Kotlin, with no Android dependency at all: it is the part
// that has to agree with the web client byte for byte, so it is the part that
// should be testable in milliseconds without a device.
include(":protocol")

// The WebRTC transport, wrapped so the app never touches org.webrtc directly.
include(":transport")

// The Android app itself.
include(":app")
