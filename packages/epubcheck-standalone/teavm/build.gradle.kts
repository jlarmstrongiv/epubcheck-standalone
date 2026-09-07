// Compile the pinned official epubcheck release (unmodified jars from ../build,
// fetched by scripts/fetch-deps.ts) with TeaVM's JavaScript backend. This is the
// project's engine: plain JavaScript, no WebAssembly. TeaVM emits the Java objects
// as ordinary JS objects, so they live under V8's regular generational GC and the
// engine's memory stays bounded in the browser and in Node.
//
// Gaps between the epubcheck stack and TeaVM's classlib are bridged by
// shims/shims.jar (see build-shims.sh): missing java.* classes as classpath
// bytecode, missing methods as classlib T-class forks, plus TeaVM extension
// policies (the ResourcesPolicy + ReflectionPolicy under shims/resources) that
// keep the resources and reflectively-reached members the whole-program compile
// would otherwise drop.
plugins {
    java
    id("org.teavm") version "0.15.0"
}

repositories {
    mavenCentral()
}

val teavmVersion = "0.15.0"

// Build-input versions flow in from scripts/build.ts as -P project properties
// (which read them from the environment mise.toml [env] supplies), with the
// environment itself as a fallback for a direct `mise exec gradle` invocation.
// There is deliberately NO version literal here: mise.toml is the single source
// of truth, so an EPUBCHECK_VERSION bump there -- or the update-epubcheck
// workflow's re-export -- flows straight into the jar paths below. Fail loudly
// if neither is present rather than silently compiling some default release.
fun requiredBuildInputVersion(property: String, envVar: String): String =
    (findProperty(property) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(envVar)?.takeIf { it.isNotBlank() }
        ?: error(
            "$property is not set. Build via `npm run build` (scripts/build.ts forwards " +
                "-P$property), or run gradle through mise so $envVar from mise.toml [env] is present.",
        )

val epubcheckVersion = requiredBuildInputVersion("epubcheckVersion", "EPUBCHECK_VERSION")
val jzlibVersion = requiredBuildInputVersion("jzlibVersion", "JZLIB_VERSION")

val ecDir = file("../build/epubcheck-$epubcheckVersion")

val epubcheckJars: FileCollection =
    files(ecDir.resolve("epubcheck.jar")) +
    fileTree(ecDir.resolve("lib")) { include("*.jar") } +
    files(file("../build/jzlib-$jzlibVersion.jar"))

val shimsJar = layout.buildDirectory.file("shims/shims.jar")

// Compile classpath for the shim jar (T-class forks compile against the real
// classlib + compiler APIs; PureJavaImageInfo against the epubcheck jars).
val shimCompile by configurations.creating

dependencies {
    shimCompile("org.teavm:teavm-classlib:$teavmVersion")
    shimCompile("org.teavm:teavm-core:$teavmVersion")
    shimCompile("org.teavm:teavm-extension-spi:$teavmVersion")

    // ORDER MATTERS: the shim jar must precede teavm-classlib on the TeaVM
    // compiler classpath so the forked T-classes shadow the stock ones.
    implementation(files(shimsJar).builtBy("buildShims"))
    implementation(epubcheckJars)
    implementation(teavm.libs.jso)
    implementation(teavm.libs.jsoApis)
}

val javaHomePath: String = System.getProperty("java.home")

tasks.register<Exec>("buildShims") {
    inputs.dir("shims")
    inputs.file("build-shims.sh")
    outputs.file(shimsJar)
    commandLine("bash", file("build-shims.sh").absolutePath)
    environment("OUT_DIR", layout.buildDirectory.dir("shims").get().asFile.absolutePath)
    environment("JAVAC", "$javaHomePath/bin/javac")
    environment("JAR", "$javaHomePath/bin/jar")
    environment("SHIM_CP", (shimCompile + epubcheckJars).asPath)
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

teavm.js {
    mainClass = "EpubCheckTeaVM"
    targetFileName = "epubcheck.js"
    obfuscated = true
    sourceMap = false
}
