package com.realtrack.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.Surface
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import java.net.HttpURLConnection
import java.net.URL
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sinh

class CarMapSurface {
    private val executor = Executors.newSingleThreadExecutor()
    private val loadingTiles = ConcurrentHashMap.newKeySet<String>()
    private val tileCache = object : LinkedHashMap<String, Bitmap>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean = size > 48
    }
    @Volatile private var surface: Surface? = null
    @Volatile private var width: Int = 0
    @Volatile private var height: Int = 0
    @Volatile private var latest = NavigationState.snapshot
    @Volatile private var destroyed = false

    val callback = object : SurfaceCallback {
        override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) {
            surface = surfaceContainer.surface
            width = surfaceContainer.width
            height = surfaceContainer.height
            destroyed = false
            draw()
        }

        override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
            destroyed = true
            surface = null
        }
    }

    fun update(snapshot: CarNavigationSnapshot) {
        latest = snapshot
        draw()
    }

    fun centerOnLocation() = draw()

    fun close() {
        destroyed = true
        surface = null
        executor.shutdownNow()
    }

    @Synchronized
    private fun draw() {
        val target = surface ?: return
        if (destroyed || width <= 0 || height <= 0) return
        val canvas = runCatching { target.lockCanvas(null) }.getOrNull() ?: return
        try {
            render(canvas, latest)
        } finally {
            runCatching { target.unlockCanvasAndPost(canvas) }
        }
    }

    private fun render(canvas: Canvas, snapshot: CarNavigationSnapshot) {
        canvas.drawColor(Color.rgb(22, 31, 42))
        val center = when {
            snapshot.latitude != null && snapshot.longitude != null -> CarCoordinate(snapshot.latitude, snapshot.longitude)
            snapshot.destination != null -> snapshot.destination
            else -> null
        }
        if (center == null) {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE
                textSize = 30f
                textAlign = Paint.Align.CENTER
            }
            canvas.drawText("Abra o Railtrak no celular para iniciar", width / 2f, height / 2f, paint)
            drawAttribution(canvas)
            return
        }

        val zoom = 16
        val centerPixel = project(center, zoom)
        val rotation = snapshot.heading?.takeIf { it >= 0.0 }?.toFloat() ?: 0f
        canvas.save()
        canvas.rotate(-rotation, width / 2f, height / 2f)
        drawTiles(canvas, centerPixel.first, centerPixel.second, zoom)
        drawRoute(canvas, snapshot.route, centerPixel.first, centerPixel.second, zoom)
        snapshot.destination?.let { drawDestination(canvas, toScreen(project(it, zoom), centerPixel.first, centerPixel.second)) }
        if (snapshot.latitude != null && snapshot.longitude != null) {
            drawLocation(canvas, width / 2f, height / 2f)
        }
        canvas.restore()
        drawAttribution(canvas)
    }

    private fun drawTiles(canvas: Canvas, centerX: Double, centerY: Double, zoom: Int) {
        val topLeftX = centerX - width / 2.0
        val topLeftY = centerY - height / 2.0
        val firstX = floor(topLeftX / TILE_SIZE).toInt()
        val firstY = floor(topLeftY / TILE_SIZE).toInt()
        val lastX = floor((topLeftX + width) / TILE_SIZE).toInt()
        val lastY = floor((topLeftY + height) / TILE_SIZE).toInt()
        val maxTile = 1 shl zoom
        for (tileY in firstY..lastY) {
            if (tileY !in 0 until maxTile) continue
            for (tileX in firstX..lastX) {
                val wrappedX = ((tileX % maxTile) + maxTile) % maxTile
                val key = "$zoom/$wrappedX/$tileY"
                val left = (tileX * TILE_SIZE - topLeftX).toFloat()
                val top = (tileY * TILE_SIZE - topLeftY).toFloat()
                val tileSize = TILE_SIZE.toFloat()
                val bitmap = synchronized(tileCache) { tileCache[key] }
                if (bitmap != null) {
                    canvas.drawBitmap(bitmap, null, RectF(left, top, left + tileSize, top + tileSize), null)
                } else {
                    canvas.drawRect(left, top, left + tileSize, top + tileSize, tileFallbackPaint)
                    loadTile(key, zoom, wrappedX, tileY)
                }
            }
        }
    }

    private fun loadTile(key: String, zoom: Int, x: Int, y: Int) {
        if (!loadingTiles.add(key)) return
        executor.execute {
            try {
                val connection = URL("https://tile.openstreetmap.org/$zoom/$x/$y.png").openConnection() as HttpURLConnection
                connection.connectTimeout = 4000
                connection.readTimeout = 5000
                connection.setRequestProperty("User-Agent", "Railtrak-AndroidAuto/1.0")
                connection.inputStream.use { input ->
                    BitmapFactory.decodeStream(input)?.let { bitmap ->
                        synchronized(tileCache) { tileCache[key] = bitmap }
                    }
                }
                connection.disconnect()
            } catch (_: Exception) {
                // Leave the fallback background in place; later location updates may retry.
            } finally {
                loadingTiles.remove(key)
            }
            draw()
        }
    }

    private fun drawRoute(canvas: Canvas, points: List<CarCoordinate>, centerX: Double, centerY: Double, zoom: Int) {
        if (points.size < 2) return
        val path = Path()
        points.forEachIndexed { index, coordinate ->
            val point = toScreen(project(coordinate, zoom), centerX, centerY)
            if (index == 0) path.moveTo(point.first, point.second) else path.lineTo(point.first, point.second)
        }
        canvas.drawPath(path, routeOutlinePaint)
        canvas.drawPath(path, routePaint)
    }

    private fun drawLocation(canvas: Canvas, x: Float, y: Float) {
        canvas.drawCircle(x, y, 18f, locationHaloPaint)
        canvas.drawCircle(x, y, 12f, locationPaint)
        val arrow = Path().apply {
            moveTo(x, y - 22f)
            lineTo(x - 9f, y + 8f)
            lineTo(x, y + 3f)
            lineTo(x + 9f, y + 8f)
            close()
        }
        canvas.drawPath(arrow, locationArrowPaint)
    }

    private fun drawDestination(canvas: Canvas, point: Pair<Float, Float>) {
        canvas.drawCircle(point.first, point.second, 12f, destinationHaloPaint)
        canvas.drawCircle(point.first, point.second, 7f, destinationPaint)
    }

    private fun drawAttribution(canvas: Canvas) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 13f
            setShadowLayer(2f, 1f, 1f, Color.BLACK)
            textAlign = Paint.Align.RIGHT
        }
        canvas.drawText("© OpenStreetMap contributors", width - 12f, height - 12f, paint)
    }

    private fun project(point: CarCoordinate, zoom: Int): Pair<Double, Double> {
        val scale = TILE_SIZE * 2.0.pow(zoom.toDouble())
        val latitude = point.latitude.coerceIn(-85.05112878, 85.05112878)
        val x = (point.longitude + 180.0) / 360.0 * scale
        val sinLatitude = sin(Math.toRadians(latitude))
        val y = (0.5 - ln((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale
        return x to y
    }

    private fun toScreen(point: Pair<Double, Double>, centerX: Double, centerY: Double) =
        (width / 2.0 + point.first - centerX).toFloat() to (height / 2.0 + point.second - centerY).toFloat()

    companion object {
        private const val TILE_SIZE = 256.0
        private val tileFallbackPaint = Paint().apply { color = Color.rgb(35, 45, 55) }
        private val routeOutlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            strokeWidth = 13f
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val routePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(0, 145, 255)
            strokeWidth = 8f
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val locationHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        private val locationPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0, 122, 255) }
        private val locationArrowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        private val destinationHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        private val destinationPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(232, 62, 62) }
    }
}
