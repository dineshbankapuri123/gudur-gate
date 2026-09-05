require("dotenv").config();
const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db = getDatabase();
const gateRef = db.ref("gudur_gates");

const RAILRADAR_API_KEY = String(process.env.RAILRADAR_API_KEY || "").trim().replace(/['"]+/g, '');
const RAILRADAR_BASE_URL = "https://api.railradar.in/v1";

const TIRUPATI_CORRIDOR_TRAINS = new Set([
  "12733", "12734", "17487", "17488", "12763", "12764", 
  "17261", "17262", "17479", "17480", "07669", "07670"
]);

function isNorthBound(trainName, destination) {
  const dest = String(destination || "").toUpperCase();
  return dest.includes("VIJAYAWADA") || dest.includes("BZA") || dest.includes("NELLORE") || dest.includes("NLR") || dest.includes("HOWRAH") || dest.includes("HWH");
}

function parseTimeToMinutes(timeStr, delayMinutes = 0) {
  if (!timeStr) return -1;
  
  let totalMinutes = -1;
  const date = new Date(timeStr);
  
  if (!isNaN(date.getTime())) {
    totalMinutes = date.getHours() * 60 + date.getMinutes();
  } else {
    const match = String(timeStr).trim().match(/(\d{1,2}):(\d{2})/);
    if (match) {
      totalMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }
  }

  if (totalMinutes === -1) return -1;
  return totalMinutes + Number(delayMinutes || 0);
}

async function updateGateSystem() {
  try {
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    console.log(`\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`);

    const boardRes = await axios.get(`${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4`, {
      headers: { 
        'Authorization': `Bearer ${RAILRADAR_API_KEY}`
      },
      timeout: 12000
    });

    const responseBody = boardRes.data;
    const trainsArray = responseBody?.data?.trains || [];
    if (!Array.isArray(trainsArray)) return;

    const upcomingList = [];
    let masGate = { status: "OPEN", waitMinutes: 0, activeTrain: "Tracks clear" };
    let tptyGate = { status: "OPEN", waitMinutes: 0, activeTrain: "Tracks clear" };

    for (const item of trainsArray) {
      const train = item.train || {};
      const live = item.live || {};
      const stop = item.stop || {};
      
      const trainNo = String(train.number || "").trim();
      const trainName = train.name || `Express ${trainNo}`;
      const destination = train.destination || train.to || item.destination || "";
      
      const delayMin = Number(live.delayMinutes || 0);
      
      // Parse arrival and departure times to handle platform halts correctly
      const arrTimeStr = stop.arrival || live.expectedArrivalTime || "";
      const depTimeStr = stop.departure || live.expectedDepartureTime || arrTimeStr;
      
      const arrMin = parseTimeToMinutes(arrTimeStr, delayMin);
      const depMin = parseTimeToMinutes(depTimeStr, delayMin);
      
      if (arrMin === -1) continue;

      let diff = arrMin - currentMin;
      if (diff < -720) diff += 1440;
      if (diff > 720) diff -= 1440;

      // Ignore trains that passed long ago or are too far out (> 45 mins)
      if (diff < -15 || diff > 45) continue;

      let corridor = "MAS";
      if (TIRUPATI_CORRIDOR_TRAINS.has(trainNo)) {
        corridor = "TPTY";
      } else if (isNorthBound(trainName, destination)) {
        corridor = "BZA";
      }

      upcomingList.push({
        trainNo,
        name: trainName,
        etaMinutes: Math.max(0, diff),
        delayMinutes: delayMin,
        corridor,
        platform: String(live.platform || "1")
      });

      // Gate Closure Conditions:
      // 1. Train is approaching within 0 to 4 minutes.
      // 2. OR Train has arrived and is currently dwelling at the station (current time is between arrival and departure).
      const isApproaching = (diff >= 0 && diff <= 4);
      const isAtStation = (currentMin >= arrMin && currentMin <= (depMin !== -1 ? depMin : arrMin + 5));

      if (isApproaching || isAtStation) {
        const waitTime = isAtStation ? Math.max(1, depMin - currentMin) : Math.max(1, diff + 2);
        const label = `${trainNo} ${trainName} (${isAtStation ? 'At Station' : delayMin > 0 ? delayMin + 'm late' : 'On Time'})`;
        const payload = {
          status: "CLOSED",
          waitMinutes: waitTime,
          activeTrain: label
        };

        if (corridor === "TPTY") {
          tptyGate = payload;
        } else if (corridor === "MAS") {
          masGate = payload;
        }
      }
    }

    upcomingList.sort((a, b) => a.etaMinutes - b.etaMinutes);
    const topUpcoming = upcomingList.slice(0, 5);

    await gateRef.set({
      tirupatiGate: tptyGate,
      chennaiGate: masGate,
      upcomingTrains: topUpcoming,
      lastUpdated: now.toLocaleTimeString()
    });

    console.log(`[SYNC SUCCESS] Firebase updated.`);
    console.log(` -> Chennai Gate : ${masGate.status} (${masGate.activeTrain})`);
    console.log(` -> Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`);

  } catch (err) {
    const status = err.response ? err.response.status : err.message;
    console.error(`[ERROR] RailRadar fetch failed: ${status}`);
  }
}

console.log("==========================================");
console.log(" RailRadar Real-time Gate Monitor Active ");
console.log(" Chennai Gate:  14.13968 N, 79.84419 E   ");
console.log(" Tirupati Gate: 14.14024 N, 79.84361 E   ");
console.log("==========================================");

updateGateSystem();
setInterval(updateGateSystem, 180000);