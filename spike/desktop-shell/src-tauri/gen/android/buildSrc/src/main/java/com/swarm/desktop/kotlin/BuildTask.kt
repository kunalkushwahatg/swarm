import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val rootDirRel = rootDirRel ?: ".."
        val root = File(projectDir, rootDirRel)
        val jniLibsDir = File(projectDir, "app/src/main/jniLibs/arm64-v8a")
        jniLibsDir.mkdirs()

        val profile = if (release == true) "release" else "debug"
        val soSource = File(root, "src-tauri/target/aarch64-linux-android/$profile/libapp_lib.so")
        val soDest = File(jniLibsDir, "libapp_lib.so")
        if (soSource.exists()) {
            soSource.copyTo(soDest, overwrite = true)
            println("Successfully copied libapp_lib.so to " + soDest.absolutePath)
        } else {
            println("Warning: soSource not found at " + soSource.absolutePath)
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script");

        execOperations.exec {
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}