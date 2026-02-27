package com.realtrack.app

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

class NavCarAppService : CarAppService() {
    override fun createHostValidator(): HostValidator {
        // Permite que o app rode no Android Auto oficial
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    }

    override fun onCreateSession(): Session {
        return NavSession()
    }
}
