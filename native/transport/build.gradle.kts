plugins {
    id("com.android.library")
    kotlin("android")
}

android {
    namespace = "chat.wisp.transport"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // No toolchain request: the JDK that runs Gradle compiles to 17 bytecode.
    // Asking for a 17 toolchain would demand a second JDK on every machine that
    // builds this, including CI.
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

dependencies {
    api(project(":protocol"))

    // libwebrtc, from the maintained mirror: Google stopped publishing
    // org.webrtc:google-webrtc to Maven Central in 2021.
    api("io.github.webrtc-sdk:android:125.6422.07")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation(kotlin("test"))
}
