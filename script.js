// UUIDs must match your Device code
const SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const CHARACTERISTIC_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";

// NOTE: BLE encryption is handled automatically by the browser/OS when connecting
// to an encrypted characteristic. No manual decryption is needed in JavaScript.

let dataLog = []; 
let isTestActive = false;
let testTimeout = null;
let testStartTime = null; // milliseconds since epoch when test started
let postureUpdateInterval = null; // interval for updating posture instruction
const statusText = document.getElementById('status');
const postureInstruction = document.getElementById('postureInstruction');
let connectedDevice = null;
let characteristicRef = null;

// Runtime debug flags (visible overlay) - COMMENTED OUT
// let debugFlags = { lastRaw: '', lastParseStep: '', lastError: '', receivedCount: 0 };
// function ensureDebugDiv() {
//     if (!document.getElementById('debugFlags')) {
//         const d = document.createElement('div');
//         d.id = 'debugFlags';
//         d.style.cssText = 'position:fixed;right:8px;bottom:8px;background:#111;color:#fff;padding:6px;font-size:12px;z-index:10000;max-width:360px;opacity:0.9;border-radius:4px;';
//         document.body.appendChild(d);
//     }
// }
// function updateDebugUI() {
//     ensureDebugDiv();
//     const d = document.getElementById('debugFlags');
//     const since = debugFlags.lastReceivedTs ? Math.floor((Date.now() - debugFlags.lastReceivedTs)/1000) + 's' : 'N/A';
//     const conn = connectedDevice ? (connectedDevice.gatt && connectedDevice.gatt.connected ? 'connected' : 'disconnected') : 'none';
//     d.innerText = `DBG: step=${debugFlags.lastParseStep}\nraw=${debugFlags.lastRaw}\nerr=${debugFlags.lastError}\ncount=${debugFlags.receivedCount}\nlast+age=${since}\ndevice=${conn}`;
// }
let debugFlags = { lastRaw: '', lastParseStep: '', lastError: '', receivedCount: 0 };
function ensureDebugDiv() { /* disabled */ }
function updateDebugUI() { /* disabled */ }

// Helper: format milliseconds to "M:SS"
function formatMsToMmSs(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// --- 1. Bluetooth Connection Logic ---
document.getElementById('connectBtn').addEventListener('click', async () => {
    try {
        statusText.innerText = "Status: Searching for Device...";

        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'POTS_Test' }],
            optionalServices: [SERVICE_UUID]
        });
        connectedDevice = device;
        // monitor disconnects
        device.addEventListener('gattserverdisconnected', () => {
            // debugFlags.lastParseStep = 'gatt_disconnected';
            // debugFlags.lastError = 'Device disconnected';
            // updateDebugUI();
            statusText.innerText = 'Status: Device disconnected. Attempting reconnect...';
            // attempt reconnect in background
            attemptReconnect();
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

        await characteristic.startNotifications();
        statusText.innerText = "Status: Connected. Press 'Start Test' to begin logging data...";

        // attach handler and keep reference
        characteristicRef = characteristic;
        characteristic.addEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);

    } catch (err) {
        console.error('Connect Error:', err);
        statusText.innerText = `Status: Error: ${err.message}`;
    }
});
        

// AES-128 Decryption Key (MUST match ESP32 key exactly)
// This is hex format: 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F
const AES_KEY_HEX = "020701080208010802080B0A0D0C0F0E";

// AES-128 ECB decryption using CryptoJS
function decryptAES128(hexCiphertext) {
    try {
        // Parse key and ciphertext as hex
        const key = CryptoJS.enc.Hex.parse(AES_KEY_HEX);
        const ciphertext = CryptoJS.enc.Hex.parse(hexCiphertext);
        
        // Decrypt using AES ECB mode with PKCS7 padding
        const decrypted = CryptoJS.AES.decrypt(
            CryptoJS.enc.Base64.stringify(ciphertext),
            key,
            {
                mode: CryptoJS.mode.ECB,
                padding: CryptoJS.pad.Pkcs7
            }
        );
        
        const plaintext = decrypted.toString(CryptoJS.enc.Utf8);
        if (!plaintext) {
            console.error("Decryption produced empty result");
            return null;
        }
        return plaintext;
    } catch (err) {
        console.error("Decryption error:", err);
        return null;
    }
}

function handleCharacteristicValueChanged(event) {
    try {
        if (!isTestActive) return; // Only log if test is active

        // Decode BLE data (now encrypted)
        const rawBytes = event.target.value;
        console.log("Raw bytes length:", rawBytes.byteLength);
        console.log("Raw bytes:", new Uint8Array(rawBytes));
        
        const encryptedHex = new TextDecoder().decode(event.target.value).trim();
        console.log("Encrypted hex string:", encryptedHex);

        // Decrypt the data
        const decodedData = decryptAES128(encryptedHex);
        if (!decodedData) {
            // debugFlags.lastParseStep = 'decryption_failed';
            // debugFlags.lastError = 'AES decryption failed';
            // debugFlags.lastRaw = encryptedHex;  // Show what we tried to decrypt
            // updateDebugUI();
            return;
        }

        // update debug flags immediately
        // debugFlags.lastRaw = decodedData;
        // debugFlags.lastParseStep = 'received';
        // debugFlags.receivedCount = (debugFlags.receivedCount || 0) + 1;
        // debugFlags.lastError = '';
        // debugFlags.lastReceivedTs = Date.now();
        // updateDebugUI();

        // Ignore keepalive message
        if (decodedData === 'K') {
            // debugFlags.lastParseStep = 'keepalive';
            // updateDebugUI();
            return;
        }

        // Handle disconnected pads message
        if (decodedData.toUpperCase() === 'L_O' || decodedData.toUpperCase() === 'PADS_OFF') {
            // debugFlags.lastParseStep = 'leads_off';
            // updateDebugUI();
            const nowMs = Date.now();
            dataLog.push({
                time: new Date(nowMs).toLocaleTimeString(),
                timestampMs: nowMs,
                value: null,
                position: null,
                leadsOff: true
            });

            // Show pads disconnected in the last value position
            let timeRemainingText = '';
            if (isTestActive && testStartTime) {
                const remainingMs = Math.max(0, (testStartTime + 15 * 60 * 1000) - Date.now());
                timeRemainingText = `Time left: ${formatMsToMmSs(remainingMs)} — `;
            }
            statusText.innerText = `Status: ${timeRemainingText}Logged ${dataLog.length} readings. Last: Pads disconnected!`;
            return; // Do not try to parse numeric data
        }

        // Expect data in the form "145,1" (primaryValue,position)
        const parts = decodedData.split(',').map(p => p.trim());
        // debugFlags.lastParseStep = 'split';
        // updateDebugUI();

        if (parts.length < 1) {
            // debugFlags.lastParseStep = 'split_fail';
            // debugFlags.lastError = 'no parts';
            // updateDebugUI();
            return;
        }

        // Parse primary numeric value (first part) with diagnostics and fallbacks
        const primaryRaw = parts[0] || '';
        // allow comma decimal, strip any non-digit/dot/comma/minus
        const replacedPrimary = primaryRaw.replace(/[^\d.,-]/g, '');
        let primaryValue = parseFloat(replacedPrimary.replace(',', '.'));

        // Fallback: try Number() on cleaned string
        if (isNaN(primaryValue)) {
            const numTry = Number(replacedPrimary.replace(',', '.'));
            if (!isNaN(numTry)) primaryValue = numTry;
        }

        // If still NaN, collect char codes and extra diagnostics for debugging
        if (isNaN(primaryValue)) {
            const codes = [...primaryRaw].map(c => c.charCodeAt(0)).join(',');
            // debugFlags.lastParseStep = 'parsePrimaryFail';
            // debugFlags.lastError = `raw:${primaryRaw} codes:${codes} cleaned:${replacedPrimary} parseFloat:${parseFloat(replacedPrimary.replace(',', '.'))} Number:${Number(replacedPrimary.replace(',', '.'))}`;;
            // updateDebugUI();
            console.warn('Primary parse diagnostics:', `raw:${primaryRaw} codes:${codes} cleaned:${replacedPrimary}`);
            return;
        }

        // Parse position value if present: 1 (standing), 0 (lying), 0.5 (unknown)
        let positionValue = null;
        if (parts.length > 1) {
            const posRaw = parts[1] || '';
            const cleanedPos = posRaw.replace(/[^\d.,-]/g, '');
            let parsedPos = parseFloat(cleanedPos.replace(',', '.'));
            if (isNaN(parsedPos)) {
                const numTry = Number(cleanedPos.replace(',', '.'));
                if (!isNaN(numTry)) parsedPos = numTry;
            }

            if (!isNaN(parsedPos)) {
                positionValue = parsedPos;
                // clear any prior parse error
                // debugFlags.lastError = '';
            } else {
                // collect char codes for diagnostics
                const codes = [...posRaw].map(c => c.charCodeAt(0)).join(',');
                // debugFlags.lastParseStep = 'parsePosFail';
                // debugFlags.lastError = `raw:${posRaw} codes:${codes} cleaned:${cleanedPos}`;
                // updateDebugUI();
            }
        }

        // All good: push to data log
        const nowMs = Date.now();
        dataLog.push({ 
            time: new Date(nowMs).toLocaleTimeString(), 
            timestampMs: nowMs,
            value: primaryValue,
            position: positionValue
        });
        // debugFlags.lastParseStep = 'pushed';
        // updateDebugUI();

        const posLabel = positionValue === null ? '' : `,${positionValue}`;
        // Prepend time remaining when test is active
        let timeRemainingText = '';
        if (isTestActive && testStartTime) {
            const remainingMs = Math.max(0, (testStartTime + 15 * 60 * 1000) - Date.now());
            timeRemainingText = `Time left: ${formatMsToMmSs(remainingMs)} — `;
        }
        statusText.innerText = `Status: ${timeRemainingText}Logged ${dataLog.length} readings. Last: ${primaryValue}${posLabel}`;
    } catch (err) {
        // debugFlags.lastError = String(err);
        // debugFlags.lastParseStep = 'handler_exception';
        // updateDebugUI();
        console.error('BLE handler exception:', err);
    }
}

// Attempt reconnect with backoff
async function attemptReconnect(maxAttempts = 5) {
    if (!connectedDevice) return;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // debugFlags.lastParseStep = `reconnect_attempt_${attempt}`;
            // updateDebugUI();
            const server = await connectedDevice.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
            await characteristic.startNotifications();
            characteristicRef = characteristic;
            characteristic.addEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);
            // debugFlags.lastParseStep = 'reconnected';
            // debugFlags.lastError = '';
            // updateDebugUI();
            statusText.innerText = 'Status: Reconnected.';
            return;
        } catch (err) {
            console.warn('Reconnect attempt failed', attempt, err);
            // debugFlags.lastError = `reconnect_fail_attempt_${attempt}`;
            // updateDebugUI();
            await new Promise(r => setTimeout(r, 1000 * attempt)); // linear backoff
        }
    }
    // debugFlags.lastParseStep = 'reconnect_failed';
    // updateDebugUI();
    statusText.innerText = 'Status: Reconnect failed. Please reconnect manually.';
}

// --- Helper: Update posture instruction based on elapsed time ---
function updatePostureInstruction() {
    if (!isTestActive || !testStartTime) return;
    
    const elapsedMs = Date.now() - testStartTime;
    const elapsedMins = elapsedMs / 60000;
    
    if (elapsedMins < 5) {
        postureInstruction.innerText = 'Lie down!';
        postureInstruction.style.backgroundColor = '#e74c3c';
        postureInstruction.style.color = 'white';
    } else {
        postureInstruction.innerText = 'Stand Up!';
        postureInstruction.style.backgroundColor = '#3498db';
        postureInstruction.style.color = 'white';
    }
}

// Refresh debug UI regularly so `last+age` updates - COMMENTED OUT
// setInterval(() => {
//     try { updateDebugUI(); } catch (e) { /* ignore */ }
// }, 1000);

// --- 2. Start Test ---
document.getElementById('startBtn').addEventListener('click', () => {
    if (isTestActive) {
        isTestActive = false;
        if (testTimeout) clearTimeout(testTimeout);
        if (postureUpdateInterval) clearInterval(postureUpdateInterval);
        dataLog = [];
        testStartTime = null;
        postureInstruction.style.display = 'none';
        statusText.innerText = "Status: Test stopped. Data cleared. Press 'Start Test' to begin again.";
        // debugFlags.lastParseStep = 'testStopped';
        // updateDebugUI();
    } else {
        isTestActive = true;
        dataLog = [];
        testStartTime = Date.now();
        postureInstruction.style.display = 'block';
        statusText.innerText = "Status: Test started. Logging data... (will auto-stop in 15 minutes)";
        // debugFlags.lastParseStep = 'testStarted';
        // updateDebugUI();
        
        // Update posture instruction every second
        updatePostureInstruction();
        postureUpdateInterval = setInterval(updatePostureInstruction, 1000);
        
        // Auto-stop after 15 minutes (900,000 milliseconds)
        testTimeout = setTimeout(() => {
            isTestActive = false;
            if (postureUpdateInterval) clearInterval(postureUpdateInterval);
            postureInstruction.style.display = 'none';
            statusText.innerText = `Status: Test auto-stopped after 15 minutes. ${dataLog.length} readings logged. Ready to export.`;
        }, 900000);
    }
});

// --- 3. CSV Export ---
document.getElementById('downloadCsv').addEventListener('click', () => {
    if (dataLog.length === 0) return alert("No data logged yet!");

    // Include position column (may be empty if not provided). Mark LEADS_OFF rows explicitly.
    const csvContent = "Time,Value,Position\n" + dataLog.map(e => {
        const val = e.leadsOff ? 'LEADS_OFF' : (e.value === null || e.value === undefined ? '' : e.value);
        const pos = (e.position === null || e.position === undefined) ? '' : e.position;
        return `${e.time},${val},${pos}`;
    }).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `POTS_Test_Data_${Date.now()}.csv`;
    a.click();
    // Revoke object URL shortly after download to avoid memory leak
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
});

// --- 3. PDF Generation ---
document.getElementById('downloadPdf').addEventListener('click', async () => {
    if (dataLog.length === 0) return alert("No data recorded yet!");

    const statusText = document.getElementById('status');
    statusText.innerText = "Status: Preparing PDF...";

    // --- STEP 1: Wait for Library (The Fix) ---
    let jsPDF;
    for (let i = 0; i < 20; i++) { // Retry for 2 seconds
        if (window.jspdf && window.jspdf.jsPDF) {
            jsPDF = window.jspdf.jsPDF;
            break;
        } else if (window.jsPDF) {
            jsPDF = window.jsPDF;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
    }

    if (!jsPDF) {
        statusText.innerText = "Status: Error - PDF Library failed to load.";
        return alert("The PDF library is still not responding. Try refreshing the page.");
    }
    // --- STEP 2: Generate PDF ---
    // Ensure Chart.js is available (try briefly if not yet loaded)
    if (!window.Chart) {
        for (let i = 0; i < 20; i++) {
            if (window.Chart) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    if (!window.Chart) {
        statusText.innerText = "Status: Error - Chart.js not loaded.";
        return alert("Chart.js is not available. Make sure the Chart.js script is loaded before generating the PDF.");
    }

    const doc = new jsPDF();
    const canvas = document.getElementById('hiddenChartCanvas');

    if (!canvas) {
        statusText.innerText = "Status: Error - Canvas not found.";
        return alert("Hidden chart canvas element not found. Add a <canvas id='hiddenChartCanvas'> element.");
    }

    // Save original styles/sizes to restore after rendering
    const origStyle = {
            display: canvas.style.display,
            visibility: canvas.style.visibility,
            position: canvas.style.position,
            left: canvas.style.left
        };
        const origWidth = canvas.width;
        const origHeight = canvas.height;

        let chartInstance = null; // Declare outside try block so finally can access it
        let startMs = null; // Declare outside try block so it can be reused for conclusions

        try {
            // Make canvas renderable without showing it on-screen
            canvas.style.display = 'block';
            canvas.style.visibility = 'hidden';
            canvas.style.position = 'absolute';
            canvas.style.left = '-9999px';

            // Give explicit pixel dimensions for reliable image quality
            const targetWidth = 1200;
            const targetHeight = 600;
            canvas.width = targetWidth;
            canvas.height = targetHeight;

            // Destroy any existing chart on the canvas before creating a new one
            // This prevents "Canvas is already in use" error on subsequent PDF generations
            try {
                const existingChart = Chart.instances.find(c => c.canvas === canvas);
                if (existingChart) existingChart.destroy();
            } catch (e) {
                // Silently ignore if no existing chart found
            }

            // Create Chart.js instance with two datasets: Heart Rate and Posture on secondary y-axis
            // Determine start time for minutes axis (use testStartTime if available)
            // Prefer explicit testStartTime; if missing, prefer first entry's timestampMs when available,
            // otherwise fall back to Date.now() to avoid producing NaN windows.
            startMs = testStartTime || (dataLog.length > 0 && dataLog[0].timestampMs ? dataLog[0].timestampMs : Date.now());
            const labels = dataLog.map(d => ((d.timestampMs - startMs) / 60000).toFixed(2));
            const heartRateData = dataLog.map(d => d.value);
            const postureData = dataLog.map(d => (d.position === null || d.position === undefined) ? null : d.position);

            chartInstance = new Chart(canvas, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Heart Rate (BPM)',
                            data: heartRateData,
                            borderColor: '#007bff',
                            backgroundColor: '#007bff',
                            yAxisID: 'y',
                            fill: false,
                            tension: 0.2
                        },
                        {
                            label: 'Posture',
                            data: postureData,
                            borderColor: '#ff9900',
                            backgroundColor: '#ff9900',
                            yAxisID: 'y1',
                            fill: false,
                            tension: 0.2,
                            pointRadius: 3
                        }
                    ]
                },
                options: {
                    animation: false,
                    responsive: false,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            title: { display: true, text: 'Time (mins)' }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: { display: true, text: 'Heart Rate (BPM)' }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: { display: true, text: 'Posture' },
                            min: 0,
                            max: 1,
                            ticks: { stepSize: 0.5 }
                        }
                    }
                }
            });

            // Force immediate draw and capture image using canvas method
            await new Promise(resolve => setTimeout(resolve, 100));
            const chartImage = canvas.toDataURL('image/png');

            // --- REPORT CONTENT ---
            let currentY = 10; // Track vertical position for dynamic spacing
            const lineHeight = 7; // Approximate line height for text
            const contentWidth = 190; // Max width for text blocks

            doc.setFontSize(18);
            doc.text("POTS Test Report", 10, currentY);
            currentY += 15; // Space after title

            // PROCEDURE PARAGRAPH: place your short procedure text below.
            // >>> EDIT BETWEEN THE NEXT TWO LINES: write your procedure paragraph here <<<
            const procedureText = `Test Procedure:
1. The user sets up the device and applies the sensing pads to the appropriate locations on the body.
2. The user starts the test and then immediately lies down (if not already doing so) for the first 5 minutes of the test.
3. At the 5 minute point the user stands up for the remainder of the test.
4. Once the test is concluded the user downloads the report (and the raw data if desired).
Note: In the below graph the posture values represent standing (=1), lying down (=0), and unknown (=0.5).`;
            // >>> END EDIT AREA <<<

            doc.setFontSize(12);
            const procedureLines = doc.splitTextToSize(procedureText, contentWidth);
            doc.text(procedureLines, 10, currentY);
            currentY += procedureLines.length * lineHeight + 10; // Add procedure height + spacing

            // Chart image
            doc.addImage(chartImage, 'PNG', 10, currentY, 180, 90);
            currentY += 95; // Image height + spacing

            // Compute summary/conclusion based on averages
            // Define windows relative to test start
            startMs = testStartTime || (dataLog.length > 0 ? dataLog[0].timestampMs : Date.now());
            const firstWindowStart = startMs + 30 * 1000; // exclude first 30s
            const firstWindowEnd = startMs + 5 * 60 * 1000 - 10 * 1000; // exclude last 10s of first 5 minutes
            const secondWindowStart = startMs + 5 * 60 * 1000 + 30 * 1000; // start of following 10 minutes, exclude its first 30s
            const secondWindowEnd = startMs + 15 * 60 * 1000; // end of following 10 minutes

            function averageInWindow(start, end) {
                // Exclude entries with null/undefined values or explicit leadsOff flags so they
                // do not contribute as 0 to the averages.
                const vals = dataLog
                    .filter(d => d.timestampMs >= start && d.timestampMs <= end && d.value !== null && d.value !== undefined && !d.leadsOff)
                    .map(d => d.value);
                if (vals.length === 0) return null;
                return vals.reduce((s, v) => s + v, 0) / vals.length;
            }

            const avgFirst = averageInWindow(firstWindowStart, firstWindowEnd);
            const avgSecond = averageInWindow(secondWindowStart, secondWindowEnd);

            // Render calculated averages below the chart (before the conclusion)
            doc.setFontSize(12);
            const avgFirstText = avgFirst === null ? 'Average HR (lying, first 5 min): N/A' : `Average HR (lying, first 5 min): ${avgFirst.toFixed(1)} BPM`;
            const avgSecondText = avgSecond === null ? 'Average HR (standing, next 10 min): N/A' : `Average HR (standing, next 10 min): ${avgSecond.toFixed(1)} BPM`;
            const avgFirstLines = doc.splitTextToSize(avgFirstText, contentWidth);
            doc.text(avgFirstLines, 10, currentY);
            currentY += avgFirstLines.length * lineHeight + 4;
            const avgSecondLines = doc.splitTextToSize(avgSecondText, contentWidth);
            doc.text(avgSecondLines, 10, currentY);
            currentY += avgSecondLines.length * lineHeight + 8;

            // CONCLUSION PARAGRAPHS: Edit the strings below to customize the report conclusions.
            // >>> EDIT BETWEEN THE NEXT TWO LINES: provide the two alternative conclusion paragraphs <<<
            const conclusionIfIncrease = `Conclusion:
The results of this test met the diagnostic criteria for POTS. The diagnostic criteria are: The user’s heart rate (once it has stabilised) upon standing from the at rest position is 30+ beats per minute higher than the resting heart rate.`;
            const conclusionIfNoIncrease = `Conclusion:
The results of this test did not meet the diagnostic criteria for POTS. The diagnostic criteria are: The user’s heart rate (once it has stabilised) upon standing from the at rest position is 30+ beats per minute higher than the resting heart rate.`;
            // >>> END EDIT AREA <<<

            let conclusionText = "Insufficient data to compute summary.";
            if (isTestActive) {
                conclusionText = "Test in progress. Data collection not yet complete. Please wait for the test to finish before generating the final report.";
            } else if (avgFirst !== null && avgSecond !== null) {
                if (avgSecond - avgFirst >= 30) {
                    conclusionText = conclusionIfIncrease;
                } else {
                    conclusionText = conclusionIfNoIncrease;
                }
            } else {
                conclusionText = "Not enough data to compute a conclusion.";
            }

            // Render conclusion with dynamic spacing
            doc.setFontSize(12);
            const conclusionLines = doc.splitTextToSize(conclusionText, contentWidth);
            doc.text(conclusionLines, 10, currentY);
            currentY += conclusionLines.length * lineHeight + 8;

            // Check for any posture anomalies (even brief ones)
            const firstWindowStanding = dataLog.some(d => 
                d.timestampMs >= firstWindowStart && d.timestampMs <= firstWindowEnd && 
                d.position !== null && d.position !== undefined && d.position > 0.5
            );
            const secondWindowLyingDown = dataLog.some(d => 
                d.timestampMs >= secondWindowStart && d.timestampMs <= secondWindowEnd && 
                d.position !== null && d.position !== undefined && d.position < 0.5
            );

            let anomalyNote = '';
            if (firstWindowStanding) {
                anomalyNote += 'NOTE: The user stood up at some point during the lying down period. ';
            }
            if (secondWindowLyingDown) {
                anomalyNote += 'NOTE: The user lay down at some point during the standing up period. ';
            }

            if (anomalyNote) {
                doc.setFontSize(10);
                const anomalyLines = doc.splitTextToSize(anomalyNote, contentWidth);
                doc.text(anomalyLines, 10, currentY);
            }

            doc.save(`Report_${Date.now()}.pdf`);

            statusText.innerText = "Status: PDF Downloaded!";
        } catch (err) {
            console.error("PDF Error:", err);
            alert("Error: " + err.message);
        } finally {
            // Destroy chart after we're done with it
            if (chartInstance) {
                chartInstance.destroy();
            }
            
            // Restore canvas styles/sizes even on error
            canvas.style.display = origStyle.display;
            canvas.style.visibility = origStyle.visibility;
            canvas.style.position = origStyle.position;
            canvas.style.left = origStyle.left;
            canvas.width = origWidth;
            canvas.height = origHeight;
        }
});
