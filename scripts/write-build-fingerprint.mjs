#!/usr/bin/env node

import path from 'node:path'
import { writeEditorBuildFingerprint } from './lib/build-fingerprint.mjs'

const pluginRoot = path.resolve(import.meta.dirname, '..')
await writeEditorBuildFingerprint(pluginRoot, path.join(pluginRoot, 'dist'))
