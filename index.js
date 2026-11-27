
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const WebPMux = require('node-webpmux');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const ANIMATED_MAX_BYTES = 480000;
const STATIC_MAX_BYTES = 100000;

// DEFAULT STICKER SETTINGS------------------------------------------------------------------------------------------------------------------------------------------
const packName = 'Maja aii 😝😝';
const authorName = 'Or crow crow 🚀🦋';
//--------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function addStickerMetadata(webpBuffer, packname, author) {
    const img = new WebPMux.Image();
    await img.load(webpBuffer);

    const exifHeader = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);

    const metadata = {
        'sticker-pack-id': 'com.sticker.bot',
        'sticker-pack-name': packname,
        'sticker-pack-publisher': author,
        emojis: ['🎐']
    };

    const jsonBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
    const exifBuffer = Buffer.concat([exifHeader, jsonBuffer]);
    exifBuffer.writeUInt32LE(jsonBuffer.length, 14);

    img.exif = exifBuffer;
    return await img.save(null);
}

function convertToWebp(inputPath, outputPath, isVideo, quality) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath);

        if (isVideo) {
            command
                .videoCodec('libwebp')
                .outputOptions([
                    '-vf',
                    'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=8',
                    '-loop', '0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0',
                    '-t', '5',
                    '-lossless', '0',
                    '-compression_level', '6',
                    '-q:v', String(quality),
                    '-pix_fmt', 'yuva420p'
                ]);
        } else {
            command.outputOptions([
                '-vf',
                'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
                '-vcodec', 'libwebp',
                '-frames:v', '1',
                '-lossless', '0',
                '-q:v', String(quality),
                '-compression_level', '6',
                '-preset', 'default',
                '-an'
            ]);
        }

        command
            .format('webp')
            .on('end', resolve)
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', stderr || err.message);
                reject(err);
            })
            .save(outputPath);
    });
}

function isValidWebp(buf) {
    return !!buf &&
        buf.length >= 20 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP';
}

function isAnimatedWebp(buf) {
    const header = buf
        .subarray(0, Math.min(buf.length, 256))
        .toString('ascii');

    return header.includes('ANIM') || header.includes('ANMF');
}

async function downloadBuffer(media, type) {
    const stream = await downloadContentFromMessage(media, type);
    const chunks = [];

    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

function getMessageType(message) {
    const types = [
        'imageMessage',
        'videoMessage',
        'stickerMessage',
        'extendedTextMessage',
        'conversation'
    ];

    return types.find(type => message?.[type] != null) || null;
}

function getStickerSettings(text) {
    const args = text.slice('!sticker'.length).trim();
    const parts = args
        .replace(/^\|/, '')
        .split('|')
        .map(part => part.trim());

    return {
        packName: parts[0] || packName,
        authorName: parts.length > 1 && parts[1]
            ? parts[1]
            : authorName
    };
}

async function startBot() {
    const { state, saveCreds } =
        await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('Scan QR Code:');
            QRCode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const reconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut;

            if (reconnect) {
                console.log('Connection closed. Reconnecting...');
                startBot();
            } else {
                console.log('Logged out. Please reconnect your WhatsApp.');
            }
        } else if (connection === 'open') {
            console.log('Sticker Bot Connected Successfully!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            let tempInput = null;
            let tempOutput = null;

            try {
                if (!msg?.message) continue;

                const commandMessage = msg.message;
                const text =
                    commandMessage.conversation ||
                    commandMessage.extendedTextMessage?.text ||
                    commandMessage.imageMessage?.caption ||
                    commandMessage.videoMessage?.caption ||
                    '';

                const commandText = text.trim();

                // Allow commands from your own account and other accounts.
                if (!/^!sticker(?:\s|\||$)/i.test(commandText)) {
                    continue;
                }

                console.log('STICKER COMMAND DETECTED!');

                const settings = getStickerSettings(commandText);
                const customPackName = settings.packName;
                const customAuthorName = settings.authorName;

                console.log('Pack:', customPackName);
                console.log('Author:', customAuthorName);

                let targetMessage = commandMessage;
                let messageType = getMessageType(targetMessage);

                // Find the media being replied to.
                if (messageType === 'extendedTextMessage') {
                    const quoted =
                        targetMessage.extendedTextMessage
                            ?.contextInfo?.quotedMessage;

                    if (!quoted) {
                        console.log('Reply to an image, video or sticker.');

                        await sock.sendMessage(msg.key.remoteJid, {
                            text: 'Reply directly to an image, video or sticker with !sticker.'
                        });

                        continue;
                    }

                    targetMessage = quoted;
                    messageType = getMessageType(targetMessage);
                }

                if (
                    ![
                        'imageMessage',
                        'videoMessage',
                        'stickerMessage'
                    ].includes(messageType)
                ) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: 'Please reply directly to an image, video or sticker.'
                    });

                    continue;
                }

                const media = targetMessage[messageType];

                // EXISTING STICKER: update metadata and send without quoting.
                if (messageType === 'stickerMessage') {
                    console.log('Updating existing sticker...');

                    const buffer = await downloadBuffer(media, 'sticker');

                    if (!isValidWebp(buffer)) {
                        throw new Error('Downloaded sticker is not valid WebP.');
                    }

                    const finalSticker = await addStickerMetadata(
                        buffer,
                        customPackName,
                        customAuthorName
                    );

                    await sock.sendMessage(msg.key.remoteJid, {
                        sticker: finalSticker
                    });

                    console.log('Sticker sent successfully!');
                    continue;
                }

                // IMAGE OR VIDEO: convert to sticker.
                const isVideo = messageType === 'videoMessage';

                console.log(
                    isVideo
                        ? 'Converting video to animated sticker...'
                        : 'Converting image to sticker...'
                );

                const buffer = await downloadBuffer(
                    media,
                    isVideo ? 'video' : 'image'
                );

                const mime = media.mimetype || '';
                let extension = isVideo ? '.mp4' : '.jpg';

                if (mime.includes('png')) extension = '.png';
                else if (mime.includes('jpeg')) extension = '.jpg';
                else if (mime.includes('webp')) extension = '.webp';
                else if (mime.includes('gif')) extension = '.gif';
                else if (mime.includes('mp4')) extension = '.mp4';

                const timestamp = Date.now();

                tempInput = path.join(
                    __dirname,
                    `temp_input_${timestamp}${extension}`
                );

                tempOutput = path.join(
                    __dirname,
                    `temp_output_${timestamp}.webp`
                );

                fs.writeFileSync(tempInput, buffer);

                const maxBytes = isVideo
                    ? ANIMATED_MAX_BYTES
                    : STATIC_MAX_BYTES;

                let quality = isVideo ? 35 : 70;
                let webp;

                for (let attempt = 0; attempt < 7; attempt++) {
                    await convertToWebp(
                        tempInput,
                        tempOutput,
                        isVideo,
                        quality
                    );

                    if (!fs.existsSync(tempOutput)) {
                        throw new Error('FFmpeg did not create output file.');
                    }

                    webp = fs.readFileSync(tempOutput);

                    if (!isValidWebp(webp)) {
                        throw new Error('FFmpeg output is not valid WebP.');
                    }

                    if (isVideo && !isAnimatedWebp(webp)) {
                        throw new Error('Video output is not animated WebP.');
                    }

                    if (webp.length <= maxBytes) break;

                    quality = Math.max(8, quality - 5);
                }

                if (webp.length > maxBytes) {
                    throw new Error(
                        `Sticker exceeds size limit: ${webp.length} bytes.`
                    );
                }

                const finalSticker = await addStickerMetadata(
                    webp,
                    customPackName,
                    customAuthorName
                );

                // No quoted message: sticker appears as a normal message.
                await sock.sendMessage(msg.key.remoteJid, {
                    sticker: finalSticker,
                    isAnimated: isVideo
                });

                console.log('Sticker sent successfully!');
            } catch (err) {
                console.error('Sticker Processing Error:', err.stack || err.message);

                try {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `Sticker error: ${err.message}`
                    });
                } catch (sendErr) {
                    console.error('Could not send error:', sendErr.message);
                }
            } finally {
                try {
                    if (tempInput && fs.existsSync(tempInput)) {
                        fs.unlinkSync(tempInput);
                    }

                    if (tempOutput && fs.existsSync(tempOutput)) {
                        fs.unlinkSync(tempOutput);
                    }
                } catch (err) {
                    console.error('Cleanup error:', err.message);
                }
            }
        }
    });
}

startBot().catch(err => {
    console.error('Bot startup error:', err.stack || err.message);
});