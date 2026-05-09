#!/usr/bin/env node
/**
 * AVL Depth Sampler entry point
 * Usage: node start-avl.js [port]
 */
const { DepthSampler } = require('./index.js');
const port = parseInt(process.argv[2]) || 4001;

const sampler = new DepthSampler({ port });
sampler.start()
  .then(() => console.log('AVL_READY'))
  .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
