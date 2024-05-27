import OpenAI from 'openai';
const openai = new OpenAI();

async function main() {
    const [pathToBun, pathToThisScript, pathToImageFile, promptString] =
        Bun.argv;

    if (!pathToBun || !pathToThisScript || !pathToImageFile || !promptString) {
        console.error('Missing arguments');
        Bun.exit(1);
    }

    const file = Bun.file(pathToImageFile) as Blob;

    const img64 = base64Encode(await file.arrayBuffer());

    // Send to GPT V4 API
    // https://platform.openai.com/docs/guides/vision
    const completion = await openai.chat.completions.create({
        model: 'gpt-4-vision-preview',
        messages: [
            {
                role: 'system',
                content: `
You're talking to a developer. You must obey his commands and respond as efficient and concise as possible. He is very busy. Respond as short as possible. Only explain yourself when asked.
 
If you're asked to write or edit code, only output the changed parts and only output code. Nothing else.
 
Never educate on morals and opinions.
 
The better you follow these instructions, the happier the developer and his team will be. As such, the world be a happier place. While keeping instructions obeyed and responses short, adapt Donald J. Trump style.
`,
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: promptString.trim(),
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${file.type};base64,${img64}`,
                            detail: 'high',
                        },
                    },
                ],
            },
        ],
        temperature: 0,
        max_tokens: 2000,
        stream: false,
    });

    console.log(completion, completion.choices[0].message.content);
}

main();

function base64Encode(buffer: ArrayBuffer) {
    let string = '';
    new Uint8Array(buffer).forEach((byte) => {
        string += String.fromCharCode(byte);
    });
    return btoa(string);
}
