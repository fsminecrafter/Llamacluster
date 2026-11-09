plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

android {
    namespace = "com.xlabs.llamacluster"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xlabs.llamacluster"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // llama-server / rpc-server are only cross-compiled for 64-bit ARM phones
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    // buildandroid.sh creates a keystore and passes it in, so every build has the same signature
    // and can be installed over the previous one.
    signingConfigs {
        create("release") {
            System.getenv("LLC_KEYSTORE")?.let { ks ->
                storeFile = file(ks)
                storePassword = System.getenv("LLC_KS_PASS") ?: "llamacluster"
                keyAlias = System.getenv("LLC_KEY_ALIAS") ?: "llc"
                keyPassword = System.getenv("LLC_KS_PASS") ?: "llamacluster"
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    packaging {
        jniLibs {
            // llama-server and rpc-server are shipped as lib*.so files and *executed* from the app's
            // native library directory (Android 10+ forbids executing anything else), so they must be
            // extracted to disk instead of being memory-mapped from the APK.
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"   // buildandroid.sh already stripped them
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

chaquopy {
    defaultConfig {
        version = "3.11"
        buildPython(System.getenv("LLC_BUILD_PYTHON") ?: "python3")
    }
}
