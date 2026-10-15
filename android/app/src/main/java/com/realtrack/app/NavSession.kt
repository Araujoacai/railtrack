package com.realtrack.app

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.Distance
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver

class NavSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen = MainCarScreen(carContext)
}

class MainCarScreen(carContext: CarContext) : Screen(carContext) {
    private val mapSurface = CarMapSurface()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var navigationAnnounced = false
    private var destroyed = false
    private val stateListener: (CarNavigationSnapshot) -> Unit = { snapshot ->
        mainHandler.post {
            if (!destroyed) {
                mapSurface.update(snapshot)
                updateNavigationLifecycle(snapshot)
                invalidate()
            }
        }
    }

    init {
        carContext.getCarService(AppManager::class.java).setSurfaceCallback(mapSurface.callback)
        NavigationState.addListener(stateListener)
        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_DESTROY) cleanup()
        })
    }

    override fun onGetTemplate(): Template {
        val state = NavigationState.snapshot
        val navigationInfo = state.instruction?.takeIf { state.destination != null }?.let { instruction ->
            val step = Step.Builder("Próxima manobra")
                .setManeuver(Maneuver.Builder(state.maneuverType).build())
                .setCue(instruction)
                .build()
            RoutingInfo.Builder()
                .setCurrentStep(
                    step,
                    Distance.create((state.instructionDistanceMeters ?: 0.0).coerceAtLeast(0.0), Distance.UNIT_METERS),
                )
                .build()
        }

        return NavigationTemplate.Builder().apply {
            setBackgroundColor(CarColor.createCustom(0xFF18212B.toInt(), 0xFF101820.toInt()))
            navigationInfo?.let(::setNavigationInfo)
            setActionStrip(
                ActionStrip.Builder()
                    .addAction(
                        Action.Builder()
                            .setTitle("Centralizar")
                            .setOnClickListener { mapSurface.centerOnLocation() }
                            .build(),
                    )
                    .build(),
            )
        }.build()
    }

    private fun cleanup() {
        if (destroyed) return
        destroyed = true
        NavigationState.removeListener(stateListener)
        if (navigationAnnounced) {
            runCatching { carContext.getCarService(NavigationManager::class.java).navigationEnded() }
            navigationAnnounced = false
        }
        mapSurface.close()
    }

    private fun updateNavigationLifecycle(snapshot: CarNavigationSnapshot) {
        val hasRoute = snapshot.navigating && snapshot.destination != null && snapshot.route.size >= 2
        if (hasRoute && !navigationAnnounced) {
            runCatching { carContext.getCarService(NavigationManager::class.java).navigationStarted() }
            navigationAnnounced = true
        } else if (!hasRoute && navigationAnnounced) {
            runCatching { carContext.getCarService(NavigationManager::class.java).navigationEnded() }
            navigationAnnounced = false
        }
    }
}
