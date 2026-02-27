package com.realtrack.app

import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.net.URISyntaxException

object SocketManager {
    private var socket: Socket? = null
    // URL oficial de produção no Render
    private const val SERVER_URL = "https://railtrack-kifj.onrender.com/"

    var onDestinationUpdate: ((name: String, lat: Double, lng: Double) -> Unit)? = null

    fun connect() {
        if (socket != null && socket!!.connected()) return

        try {
            socket = IO.socket(SERVER_URL)
            
            socket?.on(Socket.EVENT_CONNECT) {
                println("Socket conectado ao servidor nativo!")
            }

            socket?.on("destination_set") { args ->
                val data = args[0] as JSONObject
                val lat = data.getDouble("lat")
                val lng = data.getDouble("lng")
                val name = data.getString("name")
                
                // Avisa quem estiver ouvindo (a tela do Android Auto)
                onDestinationUpdate?.invoke(name, lat, lng)
            }

            socket?.connect()
        } catch (e: URISyntaxException) {
            e.printStackTrace()
        }
    }

    fun getSocket(): Socket? = socket

    fun disconnect() {
        socket?.disconnect()
    }
}
