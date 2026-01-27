import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import sharp from "sharp"
import { createWorker } from "tesseract.js"
import { v4 as uuidv4 } from "uuid"

const s3 = new S3Client({ region: "us-east-1" })

const streamToBuffer = async (stream) => {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
}

export const handler = async (event) => {
    try {
        const { bucket, key } = typeof event.body === "string" ? JSON.parse(event.body) : event.body
        const fileName = key.split('/').pop()
        const getObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const imgBuffer = await streamToBuffer(getObj.Body)

        const reject = async (reason) => {
            await s3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: fileName,
                Body: imgBuffer,
                ContentType: "image/png",
                Metadata: {
                    reason: reason
                }
            }))
            return {
                statusCode: 400,
                body: JSON.stringify({
                    status: 'rejected',
                    reason: reason
                })
            }
        }

        //VALIDATION

        //validate .png format
        if (getObj.ContentType !== "image/png") {
            reject("not a .png")
        }
        //validate file size
        const size = imgBuffer.length
        if (size < 10_000 || size > 5_000_000) {
            reject("file too small/large")
        }
        //validate dimensions and aspect ratio
        const metadata = await sharp(imgBuffer).metadata()
        const width = metadata.width
        const height = metadata.height
        const aspect = width / height
        if (Math.abs(aspect - 0.47) > 0.05) {
            reject("aspect ratio invalid")
        }
        //TODO
        //are we not checking dimensions too?

        //validate blur
        const grayscale = await sharp(imgBuffer).greyscale().raw().toBuffer({ resolveWithObject: true })
        const pixels = grayscale.data
        let mean = 0
        for (let i = 0; i < pixels.length; i++) {
            mean += pixels[i]
        }
        mean /= pixels.length
        let variance = 0
        for (let i = 0; i < pixels.length; i++) {
            varience += (pixels[i] - mean) ** 2
        }
        variance /= pixels.length
        if (variance < 500) {
            reject("image too blurry")
        }

        //OCR: validate ticket number
        const roiBuffer = await sharp(imgBuffer)
            .extract({ left: Math.round(width * 0.1), top: Math.round(height * 0.08), width: Math.round(width * 0.6), height: Math.round(height * 0.07) })
            .grayscale()
            .threshold(180)
            .toBuffer()

        const worker = createWorker()
        await worker.load()
        await worker.loadLanguage("eng")
        await worker.initialize("eng")
        await worker.setParameters({
            tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            tessedit_pageseg_mode: 7,
        });

        const { data: { text } } = await worker.recognize(roiBuffer)
        await worker.terminate()
        const ticketNumber = text.replace(/\s/g, "");
        if (!ticketNumber) {
            reject("ticket number unreadable")
        }

        //PROCESSING

        //normalize image size
        const targetWidth = 1200
        const targetHeight = Math.round(targetWidth / 0.47)
        const validatedBuffer = await sharp(imgBuffer).resize(targetWidth, targetHeight).png().toBuffer()

        //upload result
        const validatedKey = `validated/${fileName}.png`
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: validatedKey,
            Body: validatedBuffer,
            ContentType: "image/png",
            Metadata: {
                ticketNumber,
                originalKey: key
            }
        }))

        return {
            statusCode: 200,
            body: JSON.stringify({
                status: 'validated',
                ticketNumber,
                key: validatedKey
            })
        }

    } catch (err) {
        console.error(err)
        return {
            statusCode: 500,
            body: JSON.stringify({ status: "error", message: err.message })
        }
    }
}