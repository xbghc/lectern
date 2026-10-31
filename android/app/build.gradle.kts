plugins {
    id("com.android.application")
}

/*
 * 壳很薄：一个 Activity、一个 WebView、一个 JS 桥。用 Java 而不是 Kotlin，
 * 是为了少一个编译器和一套版本兼容表——这几百行代码不值得为此多拉 100MB 的依赖。
 * 网页部分由仓库根目录的 `npm run build:app` 生成到 src/main/assets/www/。
 */

val repoRoot: File = rootProject.projectDir.parentFile

/*
 * 本地版本跟着 package.json 走。Release 工作流为 preview 注入显示版本，
 * 两个发布渠道共用递增的 versionCode，正式签名的包可以相互覆盖升级。
 */
val packageVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(repoRoot.resolve("package.json").readText())?.groupValues?.get(1) ?: "0.0.0"
val webVersion: String = System.getenv("LECTERN_VERSION_NAME") ?: packageVersion
val localVersionCode: Int = packageVersion.split(".").map { it.toIntOrNull() ?: 0 }
    .let { p -> p.getOrElse(0) { 0 } * 10000 + p.getOrElse(1) { 0 } * 100 + p.getOrElse(2) { 0 } }
    .coerceAtLeast(1)
val webVersionCode: Int = System.getenv("LECTERN_VERSION_CODE")?.toInt() ?: localVersionCode
require(webVersionCode in 1..2_100_000_000) { "LECTERN_VERSION_CODE is outside Android's supported range" }

/*
 * 正式签名只在 CI 的 Release 工作流里配（密钥从 Secrets 解出来、路径走环境变量）。
 * 本地没有这些变量时 release 就是未签名的，日常装机用 debug 包。
 */
val keystorePath: String? = System.getenv("FS_KEYSTORE_FILE")

android {
    namespace = "io.github.xbghc.lectern"
    compileSdk = 36
    // 本机 SDK 里装的是这个版本；不写的话 AGP 会去下它自己默认的那个
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.github.xbghc.lectern"
        // WebViewAssetLoader、adaptive icon、MediaStore.Downloads 分别要 21 / 26 / 29；
        // 26 起图标只需要一份 XML，29 以下的「保存到下载」退回分享
        minSdk = 26
        targetSdk = 36
        versionCode = webVersionCode
        versionName = webVersion
        // ML Kit 的原生库 11MB 且在 APK 里不压缩，按 ABI 各带一份就是 40MB 以上；面向 2019 年后常见的 arm64 手机，只留一份。
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("FS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("FS_KEY_ALIAS")
                keyPassword = System.getenv("FS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
    }
}

/*
 * 网页产物由仓库根目录的 `npm run build:app` 生成。挂到 preBuild 上，
 * 免得改了 TypeScript 忘了重新打包、装到手机上的还是旧页面。
 * 声明了输入输出，源码没变时 Gradle 会跳过它。
 */
val buildWeb = tasks.register<Exec>("buildWeb") {
    description = "npm run build:app → src/main/assets/www"
    group = "build"
    workingDir = repoRoot
    val npm = if (System.getProperty("os.name").lowercase().contains("win")) "npm.cmd" else "npm"
    commandLine(npm, "run", "build:app")
    inputs.dir(repoRoot.resolve("src"))
    inputs.files(repoRoot.resolve("build.mjs"), repoRoot.resolve("package.json"))
    inputs.property("releaseVersionName", webVersion)
    outputs.dir(project.file("src/main/assets/www"))
}
tasks.named("preBuild") { dependsOn(buildWeb) }

dependencies {
    // 中文（含拉丁字母）模型随 APK 打包，没有 Google Play 服务也能离线识别。
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    // OnBackPressedDispatcher：Android 13+ 的预测式返回不再调 onBackPressed()
    implementation("androidx.activity:activity:1.10.1")
    // WebViewAssetLoader：把 assets 用 https://appassets.androidplatform.net 端出来，页面才有一个真实的 origin
    implementation("androidx.webkit:webkit:1.14.0")
    // FileProvider：分享导出文件
    implementation("androidx.core:core:1.16.0")
}

