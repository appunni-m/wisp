plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "chat.wisp.android"
    compileSdk = 36

    defaultConfig {
        // Deliberately not chat.wisp.app yet: the Capacitor app still uses that
        // name, and the two have to coexist until the cut-over. ("native" would
        // be a Java keyword and cannot be a package segment, which is why this
        // is "android".)
        applicationId = "chat.wisp.android"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
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

    // libwebrtc ships native code for four architectures, and a device needs
    // one. Without this the APK carries all four; with it, each is a separate
    // artifact, which is what an app bundle does automatically on the Play Store.
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation(project(":transport"))
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
