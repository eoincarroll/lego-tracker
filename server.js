const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK (inherits Cloud Run default service account credentials)
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware Setup
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const REBRICKABLE_API_KEY = process.env.REBRICKABLE_API_KEY;

/**
 * Normalizes set numbers into standard Rebrickable format (e.g. "75212" -> "75212-1")
 */
function normalizeSetNum(input) {
    if (!input) return '';
    let cleaned = input.trim();
    if (cleaned.includes('rebrickable.com')) {
        const match = cleaned.match(/sets\/([^\/]+)/);
        if (match) cleaned = match[1];
    }
    if (!cleaned.includes('-')) {
        cleaned = `${cleaned}-1`;
    }
    return cleaned;
}

// -----------------------------------------------------------------------------
// ENDPOINTS
// -----------------------------------------------------------------------------

/**
 * Fetch set metadata and full parts breakdown from Rebrickable
 */
app.get('/api/set/:setNum', async (req, res) => {
    const rawSetNum = req.params.setNum;
    const setNum = normalizeSetNum(rawSetNum);

    if (!REBRICKABLE_API_KEY) {
        return res.status(500).json({ error: 'REBRICKABLE_API_KEY environment variable is not configured on Cloud Run.' });
    }

    try {
        const headers = { 'Authorization': `key ${REBRICKABLE_API_KEY}` };

        // Fetch set overview
        const setRes = await fetch(`https://rebrickable.com/api/v3/lego/sets/${setNum}/`, { headers });
        if (!setRes.ok) {
            if (setRes.status === 404) return res.status(404).json({ error: `Set ${setNum} not found on Rebrickable.` });
            throw new Error(`Rebrickable API error: ${setRes.statusText}`);
        }
        const setData = await setRes.json();

        // Fetch parts listing across paginated results
        let parts = [];
        let nextPageUrl = `https://rebrickable.com/api/v3/lego/sets/${setNum}/parts/?page_size=1000`;

        while (nextPageUrl) {
            const partsRes = await fetch(nextPageUrl, { headers });
            if (!partsRes.ok) throw new Error('Failed to fetch set parts from Rebrickable.');
            const partsData = await partsRes.json();
            
            const formattedParts = partsData.results.map(item => ({
                partNum: item.part.part_num,
                name: item.part.name,
                color: item.color.name,
                colorId: item.color.id,
                qtyRequired: item.quantity,
                qtyHave: 0,
                imageUrl: item.part.part_img_url || item.color.color_img_url || null,
                elementId: item.element_id
            }));

            parts = parts.concat(formattedParts);
            nextPageUrl = partsData.next;
        }

        const payload = {
            setNum: setData.set_num,
            name: setData.name,
            year: setData.year,
            themeId: setData.theme_id,
            totalParts: setData.num_parts,
            setImageUrl: setData.set_img_url,
            parts: parts
        };

        res.json(payload);

    } catch (err) {
        console.error(`Error fetching set ${setNum}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Retrieve user's entire saved inventory from Firestore
 */
app.get('/api/progress/:userId', async (req, res) => {
    const userId = req.params.userId || 'default_user';

    try {
        const snapshot = await db.collection('users').doc(userId).collection('saved_sets').get();
        if (snapshot.empty) {
            return res.json({ userId, savedSets: {} });
        }

        const savedSets = {};
        snapshot.forEach(doc => {
            savedSets[doc.id] = doc.data().data;
        });

        res.json({ userId, savedSets });
    } catch (err) {
        console.error('Error fetching progress from Firestore:', err);
        res.status(500).json({ error: 'Failed to retrieve saved progress' });
    }
});

/**
 * Save single set state to Firestore
 */
app.post('/api/progress/save-set', async (req, res) => {
    const { userId, setNum, setProgress } = req.body;
    const targetUser = userId || 'default_user';

    if (!setNum || !setProgress) {
        return res.status(400).json({ error: 'Missing setNum or setProgress in payload' });
    }

    try {
        const docRef = db.collection('users').doc(targetUser).collection('saved_sets').doc(setNum);
        
        await docRef.set({
            data: setProgress,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ message: `Progress saved successfully for set ${setNum}` });
    } catch (err) {
        console.error('Error saving set progress:', err);
        res.status(500).json({ error: 'Failed to save set progress to Firestore' });
    }
});

/**
 * Backup upload endpoint to import local JSON data directly into Firestore
 */
app.post('/api/progress/upload-json', upload.single('backupFile'), async (req, res) => {
    const userId = req.body.userId || 'default_user';

    if (!req.file) {
        return res.status(400).json({ error: 'No JSON backup file uploaded' });
    }

    try {
        const fileContent = req.file.buffer.toString('utf-8');
        const parsedData = JSON.parse(fileContent);

        const batch = db.batch();
        const userRef = db.collection('users').doc(userId).collection('saved_sets');

        const setsToImport = parsedData.savedSets || parsedData;

        let count = 0;
        for (const [setNum, setData] of Object.entries(setsToImport)) {
            if (typeof setData === 'object' && setData !== null) {
                const docRef = userRef.doc(setNum);
                batch.set(docRef, {
                    data: setData,
                    importedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                count++;
            }
        }

        await batch.commit();

        res.json({ message: `Successfully imported ${count} set(s) into Firestore.` });
    } catch (err) {
        console.error('Error processing JSON file upload:', err);
        res.status(500).json({ error: `Invalid JSON format or database error: ${err.message}` });
    }
});

// Single Page App fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});