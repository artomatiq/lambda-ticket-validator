import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import sharp from "sharp"
import { createWorker } from "tesseract.js"

const s3 = new S3Client({ region: "us-east-1" })

let worker
let workerInitialized = false
const initWorker = async () => {
    if (!workerInitialized) {
        worker = await createWorker()
        await worker.setParameters({
            tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            tessedit_pageseg_mode: 7,
        });
        workerInitialized = true
    }
}

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
                Key: `rejected/${fileName}`,
                Body: imgBuffer,
                ContentType: "image/png",
                Metadata: {
                    reason: reason,
                    imageKey: fileName
                }
            }))
            return {
                statusCode: 400,
                body: JSON.stringify({
                    status: 'rejected',
                    reason: reason,
                    imageKey: `rejected/${fileName}.png`
                })
            }
        }

        //VALIDATION

        //validate .png format
        console.log('file format: ', getObj.ContentType);
        if (getObj.ContentType !== "image/png") {
            return reject("not a .png")
        }
        //validate file size
        const size = imgBuffer.length
        console.log('file size: ', size);
        if (size < 10_000 || size > 5_000_000) {
            return reject("file too small/large")
        }
        //validate dimensions and aspect ratio
        const metadata = await sharp(imgBuffer).metadata()
        const width = metadata.width
        const height = metadata.height
        const aspect = width / height
        console.log('aspect ratio: ', aspect);
        if (Math.abs(aspect - 0.47) > 0.05) {
            return reject("aspect ratio invalid")
        }
        //validate blur
        const grayscale = await sharp(imgBuffer).greyscale().raw().toBuffer({ resolveWithObject: true })
        const pixels = grayscale.data
        let mean = 0
        for (let i = 0; i < pixels.length; i++) mean += pixels[i]
        mean /= pixels.length
        let variance = 0
        for (let i = 0; i < pixels.length; i++) variance += (pixels[i] - mean) ** 2
        variance /= pixels.length
        console.log('variance: ', variance);
        if (variance < 500) {
            return reject("image too blurry")
        }
        //OCR: validate ticket number
        const roiBuffer = await sharp(imgBuffer)
            .extract({ 
                left: Math.round(width * 0.667), 
                top: Math.round(height * 0.005), 
                width: Math.round(width * 0.33), 
                height: Math.round(height * 0.07) })
            .grayscale()
            .threshold(180)
            .toBuffer()
        await initWorker()
        const { data: { text } } = await worker.recognize(roiBuffer)
        const ticketNumber = text.replace(/\s/g, "");
        console.log('ticket number detected: ', ticketNumber);
        if (!ticketNumber) {
            return reject("ticket number unreadable")
        }

        //PROCESSING

        //normalize image size
        const targetWidth = 1200
        const targetHeight = Math.round(targetWidth / 0.47)
        const validatedBuffer = await sharp(imgBuffer).resize(targetWidth, targetHeight).png().toBuffer()
        console.log("Validated image size (KB):", (validatedBuffer.length / 1024).toFixed(2))
        console.log("Validated image size (MB):", (validatedBuffer.length / 1024 / 1024).toFixed(2))

        //UPLOAD

        //upload result
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: `validated/${fileName}.png`,
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
                imageKey: `validated/${fileName}.png`
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