#!/usr/bin/env node
import { rebuild } from '@electron/rebuild'
import sh from 'shelljs'
import path from 'node:path'
import fs from 'node:fs'
import * as vars from './vars.mjs'
import log from 'npmlog'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))


let target = path.resolve(__dirname, '../builtin-plugins')
// This directory is a disposable packaging stage.  Reusing it can leave
// nested copies of plugins from a previous interrupted build.
sh.rm('-rf', target)
sh.mkdir('-p', target)
fs.writeFileSync(path.join(target, 'package.json'), '{}')
sh.cd(target)
for (const plugin of vars.builtinPlugins) {
    if (plugin === 'tabby-web') {
        continue
    }
    log.info('install', plugin)
    sh.cp('-r', path.join('..', plugin), '.')
    sh.rm('-rf', path.join(plugin, 'node_modules'))
    sh.cd(plugin)
    const install = sh.exec('yarn install --force --production')
    if (install.code !== 0) {
        throw new Error(`Could not install production dependencies for ${plugin}`)
    }


    log.info('rebuild', 'native')
    if (fs.existsSync('node_modules')) {
        await rebuild({
            buildPath: path.resolve('.'),
            electronVersion: vars.electronVersion,
            arch: process.env.ARCH ?? process.arch,
            force: true,
            useCache: false,
        })
    }
    sh.cd('..')
}
fs.unlinkSync(path.join(target, 'package.json'))
