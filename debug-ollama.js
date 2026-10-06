#!/usr/bin/env node

/**
 * Debug script to check if Ollama server is accessible and has models
 */

// Check if we can access the Ollama server
const fetch = require('node-fetch');

async function debugOllama() {
    const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    
    console.log('Debugging Ollama connection...');
    console.log(`Ollama URL: ${OLLAMA_URL}`);
    
    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        
        if (response.ok) {
            const data = await response.json();
            console.log('✓ Successfully connected to Ollama');
            console.log('Models found:', data.models ? data.models.length : 0);
            
            if (data.models && data.models.length > 0) {
                console.log('\nAvailable models:');
                data.models.forEach(model => {
                    console.log(`  - ${model.name}`);
                });
            } else {
                console.log('No models found in Ollama. You may need to pull some models first.');
            }
        } else {
            console.log(`✗ Failed to connect to Ollama: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.log(`✗ Error connecting to Ollama: ${error.message}`);
        console.log('Make sure Ollama is running locally with "ollama serve"');
    }
}

debugOllama();