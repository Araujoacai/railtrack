package com.realtrack.app

import java.util.concurrent.CopyOnWriteArraySet

data class CarCoordinate(val latitude: Double, val longitude: Double)

data class CarNavigationSnapshot(
    val latitude: Double? = null,
    val longitude: Double? = null,
    val heading: Double? = null,
    val destinationName: String? = null,
    val destination: CarCoordinate? = null,
    val route: List<CarCoordinate> = emptyList(),
    val distanceMeters: Double? = null,
    val durationSeconds: Double? = null,
    val instruction: String? = null,
    val instructionDistanceMeters: Double? = null,
    val maneuverType: Int = 0,
    val navigating: Boolean = false,
)

object NavigationState {
    @Volatile
    var snapshot: CarNavigationSnapshot = CarNavigationSnapshot()
        private set

    private val listeners = CopyOnWriteArraySet<(CarNavigationSnapshot) -> Unit>()

    fun update(transform: (CarNavigationSnapshot) -> CarNavigationSnapshot) {
        snapshot = transform(snapshot)
        listeners.forEach { listener -> listener(snapshot) }
    }

    fun addListener(listener: (CarNavigationSnapshot) -> Unit) {
        listeners.add(listener)
        listener(snapshot)
    }

    fun removeListener(listener: (CarNavigationSnapshot) -> Unit) {
        listeners.remove(listener)
    }
}
