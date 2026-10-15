package com.realtrack.app

import android.webkit.JavascriptInterface
import androidx.car.app.navigation.model.Maneuver
import org.json.JSONObject
import kotlin.math.abs

class AndroidAutoBridge {
    @JavascriptInterface
    fun setNavigating(navigating: Boolean) {
        NavigationState.update { it.copy(navigating = navigating) }
    }

    @JavascriptInterface
    fun onLocation(latitude: Double, longitude: Double, heading: Double) {
        if (!validCoordinate(latitude, longitude)) return
        NavigationState.update {
            it.copy(
                latitude = latitude,
                longitude = longitude,
                heading = heading.takeIf { value -> value.isFinite() && value >= 0.0 },
            )
        }
    }

    @JavascriptInterface
    fun onDestination(name: String, latitude: Double, longitude: Double) {
        if (!validCoordinate(latitude, longitude)) return
        NavigationState.update {
            it.copy(
                destinationName = name.take(100),
                destination = CarCoordinate(latitude, longitude),
                route = emptyList(),
                instruction = null,
                navigating = false,
            )
        }
    }

    @JavascriptInterface
    fun onRoute(json: String) {
        runCatching {
            val data = JSONObject(json)
            val pointsJson = data.optJSONArray("points") ?: return
            val points = buildList {
                for (index in 0 until minOf(pointsJson.length(), 3000)) {
                    val point = pointsJson.optJSONObject(index) ?: continue
                    val lat = point.optDouble("lat", Double.NaN)
                    val lng = point.optDouble("lng", Double.NaN)
                    if (validCoordinate(lat, lng)) add(CarCoordinate(lat, lng))
                }
            }
            if (points.size < 2) return
            NavigationState.update {
                it.copy(
                    route = points,
                    distanceMeters = data.optDouble("distanceMeters").takeIf(Double::isFinite),
                    durationSeconds = data.optDouble("durationSeconds").takeIf(Double::isFinite),
                    instruction = data.optString("instruction").takeIf(String::isNotBlank),
                    instructionDistanceMeters = data.optDouble("instructionDistanceMeters").takeIf(Double::isFinite),
                    maneuverType = data.optInt("maneuverType", Maneuver.TYPE_UNKNOWN),
                    navigating = data.optBoolean("navigating", false),
                )
            }
        }
    }

    @JavascriptInterface
    fun onDestinationCleared() {
        NavigationState.update { current ->
            current.copy(
                destinationName = null,
                destination = null,
                route = emptyList(),
                distanceMeters = null,
                durationSeconds = null,
                instruction = null,
                instructionDistanceMeters = null,
                maneuverType = Maneuver.TYPE_UNKNOWN,
                navigating = false,
            )
        }
    }

    private fun validCoordinate(latitude: Double, longitude: Double): Boolean =
        latitude.isFinite() && longitude.isFinite() && abs(latitude) <= 90.0 && abs(longitude) <= 180.0
}
