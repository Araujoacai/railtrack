package com.realtrack.app

import android.content.Intent
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.model.*
import androidx.car.app.navigation.model.*

class NavSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        return MainCarScreen(carContext)
    }
}

class MainCarScreen(carContext: CarContext) : Screen(carContext) {
    private var currentDestination: String? = null

    init {
        // Registra o listener para atualizar a tela quando o destino mudar na web
        SocketManager.onDestinationUpdate = { name, lat, lng ->
            currentDestination = name
            invalidate() // Força o Android Auto a chamar onGetTemplate() novamente
        }
    }

    override fun onGetTemplate(): Template {
        val title = if (currentDestination != null) "Indo para: $currentDestination" else "Aguardando destino..."
        val instruction = if (currentDestination != null) "Calculando melhor rota..." else "Escolha um local no celular"

        val maneuver = Maneuver.Builder(Maneuver.TYPE_UNKNOWN)
            .build()

        return NavigationTemplate.Builder()
            .setNavigationInfo(
                RoutingInfo.Builder()
                    .setCurrentStep(
                        Step.Builder(title)
                            .setManeuver(maneuver)
                            .setCue(instruction)
                            .build(),
                        Distance.create(0.0, Distance.UNIT_METERS)
                    )
                    .build()
            )
            .setActionStrip(
                ActionStrip.Builder()
                    .addAction(
                        Action.Builder()
                            .setTitle("Centralizar")
                            .setOnClickListener { invalidate() }
                            .build()
                    )
                    .build()
            )
            .build()
    }
}
