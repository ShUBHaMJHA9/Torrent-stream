import express from "express";
import WebTorrent from "webtorrent";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const client = new WebTorrent();
const streams = {}; // store active sessions

// ---------------------------
// POST /stream
// ---------------------------
app.post("/stream", (req, res) => {
    const magnet = req.body.magnet;
    if (!magnet) return res.status(400).json({ error: "magnet required" });

    const streamId = randomBytes(4).toString("hex");
    const outputFolder = `/tmp/${streamId}`;
    fs.mkdirSync(outputFolder);

    client.add(magnet, (torrent) => {
        const file = torrent.files.find((f) =>
            f.name.endsWith(".mp4") || f.name.endsWith(".mkv")
        );

        if (!file) return;

        const filePath = path.join(outputFolder, file.name);
        file.getBuffer((err, buf) => {
            if (err) return;

            fs.writeFileSync(filePath, buf);

            // Convert to HLS
            ffmpeg(filePath)
                .output(`${outputFolder}/playlist.m3u8`)
                .addOptions([
                    "-profile:v baseline",
                    "-level 3.0",
                    "-start_number 0",
                    "-hls_time 4",
                    "-hls_list_size 0",
                    "-f hls",
                ])
                .on("end", () => console.log("HLS Ready:", streamId))
                .run();
        });
    });

    streams[streamId] = outputFolder;

    res.json({
        stream_id: streamId,
        hls_url: `/hls/${streamId}/playlist.m3u8`,
        mp4_url: `/stream/${streamId}`
    });
});

// ---------------------------
// HLS STREAM
// ---------------------------
app.use("/hls/:id", (req, res, next) => {
    const folder = streams[req.params.id];
    if (!folder) return res.status(404).send("Invalid stream");

    express.static(folder)(req, res, next);
});

// ---------------------------
// DIRECT STREAM (MP4)
// ---------------------------
app.get("/stream/:id", (req, res) => {
    const folder = streams[req.params.id];
    if (!folder) return res.status(404).send("Invalid stream");

    const file = fs.readdirSync(folder).find(f => f.endsWith(".mp4") || f.endsWith(".mkv"));
    const filePath = path.join(folder, file);

    res.sendFile(filePath);
});

// ---------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on", port));
