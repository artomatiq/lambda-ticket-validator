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

        //download image from S3
        const getObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const imgBuffer = await streamToBuffer(getObj.Body)

        //validate .png format
        if (getObj.ContentType !== "image/png") {
            return {
                statusCode: 400,
                body: JSON.stringify({ status: 'rejected', reason: "not a .png" })
            }
        }
        //validate file size
        const size = imgBuffer.length
        if (size < 10_000 || size > 5_000_000) {
            return {
                statusCode: 400,
                body: JSON.stringify({ status: 'rejected', reason: "file too small/large" })
            }
        }
        //validate dimensions and aspect ratio
        const metadata = await sharp(imgBuffer).metadata()
        const width = metadata.width
        const height = metadata.height
        const aspect = width / height
        if (Math.abs(aspect - 0.47) > 0.05) {
            return {
                statusCode: 400,
                body: JSON.stringify({ status: 'rejected', reason: "aspect ratio invalid" })
            }
        }
        //TODO
        //are we not checking dimensions too?

        //blur sanity check
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
            return {
                statusCode: 400,
                body: JSON.stringify({ status: 'rejected', reason: "image too blurry" })
            }
        }

        //OCR: extract ticket number
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

        const { data: {text} } = await worker.recognize(roiBuffer)
        await worker.terminate()
        const ticketNumber = text.replace(/\s/g, "");
        if (!ticketNumber) {
            return {
                statusCode: 400,
                body: JSON.stringify({ status: 'rejected', reason: "ticket number unreadable" })
            }
        }

    } catch (err) {
        console.error(err)
        return {
            statusCode: 500,
            body: JSON.stringify({ status: "error", message: err.message })
        }
    }
}