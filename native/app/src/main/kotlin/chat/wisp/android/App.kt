package chat.wisp.android

import android.app.Application
import chat.wisp.transport.installTransport

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // libwebrtc needs the application context and a one-time initialisation
        // before any peer connection exists.
        installTransport(this)
    }
}
