import fs from "fs"
import path from "path"
import { S3Client } from "@aws-sdk/client-s3"
import { handler } from "./index.mjs"

const TEST_IMAGE_PATH = "./test-images/sample.png"

const BUCKET = "local-test-bucket"
const KEY = "raw/sample.png"

S3Client.prototype.send = async function (command) {
    const name = command.constructor.name

    if (name === "GetObjectCommand") {
        return {
            Body: fs.createReadStream(TEST_IMAGE_PATH),
            ContentType: "image/png"
        }
    }
    if (name === "PutObjectCommand") {
        const outPath = "./output" + path.basename(command.input.Key)
        fs.mkdirSync("./output", {recursive: true})
        fs.writeFileSync(outPath, command.input.Body)
        console.log("Saved output to: ", outPath)
        return {}
    }
    throw new Error("Unknown S3 command")
}

const event = {
    body: JSON.stringify({
        bucket: BUCKET,
        key: KEY
    })
};

( async () => {
    const result = await handler(event)
    console.log("Lambda result:", result)
})()