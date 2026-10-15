const esbuild = require('esbuild')
const path = require('path')

const distDir = path.join(process.cwd(), 'dist')

async function build(entryFile, outFile) {
    console.log(`Building ${entryFile}...`)
    await esbuild.build({
        entryPoints: [entryFile],
        outfile: path.join(distDir, outFile),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
    })
}

async function main() {
    await build('index.js', 'index.js')
    await build('cleanup.js', 'cleanup.js')
    console.log('Done')
}

main()
