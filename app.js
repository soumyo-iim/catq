/**
 * QuizPro Main Application Controller
 * Handles local directory scanning, active quiz state, history tracking, and view logic.
 */

// Application State
let state = {
    dirHandle: null,
    loadedFiles: {}, // { filename: { filename, content, questions: [], lastModified } }
    selectedFiles: {}, // { filename: boolean }
    activeQuiz: null, // Current quiz state
    customSelectors: {
        questionBlockSelector: '',
        questionTextSelector: '',
        optionSelector: '',
        correctIndicatorSelector: '',
        explanationSelector: ''
    },
    view: 'dashboard', // dashboard, quiz, results, parser
    history: []
};

// Quiz Class
class ActiveQuiz {
    constructor(questions, mode, durationMinutes) {
        this.questions = questions; // Compiled question objects
        this.mode = mode; // 'study' or 'exam'
        this.durationSeconds = durationMinutes * 60;
        this.timeRemaining = this.durationSeconds;
        this.currentIdx = 0;
        this.answers = {}; // { qIdx: selectedOptIdx }
        this.flagged = {}; // { qIdx: boolean }
        this.checked = {}; // { qIdx: boolean } (revealed in study mode)
        this.startTime = Date.now();
        this.timerId = null;
    }
}

// --- IndexedDB Helpers for Directory Handle Persistence ---
const DB_NAME = 'QuizProStore';
const STORE_NAME = 'handles';

function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveHandle(handle) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.put(handle, 'questionsDir');
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('Failed to save directory handle:', e);
    }
}

async function getSavedHandle() {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get('questionsDir');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        return null;
    }
}

// --- UI Elements Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    initApp();
});

async function initApp() {
    // Event listeners
    document.getElementById('btn-select-folder').addEventListener('click', selectDirectory);
    document.getElementById('dir-picker-fallback').addEventListener('change', handleFallbackDirectory);
    document.getElementById('q-count-slider').addEventListener('input', updateSliderDisplay);
    document.getElementById('btn-start-quiz').addEventListener('click', startQuizHandler);
    document.getElementById('btn-prev-q').addEventListener('click', prevQuestion);
    document.getElementById('btn-next-q').addEventListener('click', nextQuestion);
    document.getElementById('btn-check-q').addEventListener('click', checkAnswer);
    document.getElementById('btn-flag-q').addEventListener('click', toggleFlagQuestion);
    document.getElementById('btn-submit-quiz').addEventListener('click', submitQuizHandler);
    document.getElementById('btn-quit-quiz').addEventListener('click', quitQuizHandler);
    
    // Load config from localStorage
    loadSelectorsFromStorage();
    
    // Load historical stats
    loadHistory();
    renderHistory();
    updateDashboardStats();

    // Check if browser supports modern Directory Picker
    if (!window.showDirectoryPicker) {
        // Log info or fallback message
        console.log('showDirectoryPicker is not supported in this browser. Falling back to input directory mode.');
    } else {
        // Try restoring saved handle
        const savedHandle = await getSavedHandle();
        if (savedHandle) {
            state.dirHandle = savedHandle;
            document.getElementById('connected-dir-name').innerText = savedHandle.name;
            document.getElementById('connected-dir-name').title = `Click Select Folder to grant permission or change.`;
            document.getElementById('scan-status-text').innerText = 'Awaiting Grant';
            
            // We can ask user to verify access
            const btn = document.getElementById('btn-select-folder');
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="white" style="margin-right: 4px;">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V7h2v5zm4 4h-2v-2h2v2zm0-4h-2V7h2v5z"/>
                </svg>
                Restore Connection
            `;
        }
    }

    // Set slider max on DOM load
    updateSliderDisplay();
    
    // Start background scanner polling (every 4 seconds)
    setInterval(backgroundFolderSync, 4000);
}

// --- Directory Picker / File Loading logic ---

async function selectDirectory() {
    if (window.showDirectoryPicker) {
        try {
            // Request permission
            const handle = await window.showDirectoryPicker({
                mode: 'read'
            });
            state.dirHandle = handle;
            await saveHandle(handle);
            
            // Visual Updates
            document.getElementById('connected-dir-name').innerText = handle.name;
            document.getElementById('connected-dir-name').title = handle.name;
            document.getElementById('scan-status').classList.add('active');
            document.getElementById('scan-status-text').innerText = 'Live Syncing';
            
            // Restore button text
            document.getElementById('btn-select-folder').innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="white" style="margin-right: 4px;">
                    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
                Change Folder
            `;

            // Initial Scan
            await syncDirectoryFiles();
        } catch (err) {
            console.error('Directory selection failed:', err);
        }
    } else {
        // Fallback for Firefox/Safari
        document.getElementById('dir-picker-fallback').click();
    }
}

function getCleanRelativePath(file) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length > 1) {
        return parts.slice(1).join('/');
    }
    return file.name;
}

async function handleFallbackDirectory(e) {
    const files = Array.from(e.target.files);
    const htmlFiles = files.filter(f => f.name.endsWith('.html'));
    const txtFiles = files.filter(f => f.name.endsWith('.txt'));

    if (htmlFiles.length === 0) {
        alert('No HTML files found in the selected folder!');
        return;
    }

    // Create a dictionary of available text files for quick lookup
    const txtFilesMap = {};
    txtFiles.forEach(f => {
        const cleanRelPath = getCleanRelativePath(f).replace(/\\/g, '/');
        const relPathWithoutExt = cleanRelPath.substring(0, cleanRelPath.lastIndexOf('.'));
        const normalizedKey = relPathWithoutExt.toLowerCase().trim();
        txtFilesMap[normalizedKey] = f;
    });

    // Update Directory label
    const folderPath = htmlFiles[0].webkitRelativePath;
    const folderName = folderPath.split('/')[0] || 'Selected Folder';
    document.getElementById('connected-dir-name').innerText = folderName;
    document.getElementById('connected-dir-name').title = folderName;
    document.getElementById('scan-status').classList.remove('active'); // No live polling in fallback
    document.getElementById('scan-status-text').innerText = 'Loaded (Static)';

    // Load each file
    state.loadedFiles = {};
    for (const file of htmlFiles) {
        const text = await readFileAsText(file);
        const cleanRelPath = getCleanRelativePath(file).replace(/\\/g, '/');
        
        // Look for matching answer key text file
        let answerKeyText = '';
        const relPathWithoutExt = cleanRelPath.substring(0, cleanRelPath.lastIndexOf('.'));
        const normalizedKey = relPathWithoutExt.toLowerCase().trim();
        const matchingTxtFile = txtFilesMap[normalizedKey];
        if (matchingTxtFile) {
            answerKeyText = await readFileAsText(matchingTxtFile);
        }

        const questions = QuizParser.parse(text, state.customSelectors, answerKeyText);
        
        state.loadedFiles[cleanRelPath] = {
            filename: file.name,
            relativePath: cleanRelPath,
            content: text,
            questions: questions,
            lastModified: file.lastModified,
            txtLastModified: matchingTxtFile ? matchingTxtFile.lastModified : 0,
            answerKeyText: answerKeyText
        };
        // Detected files are NOT auto-selected initially
        state.selectedFiles[cleanRelPath] = false;
    }

    renderFileList();
    updateCompiledQuestionCount();
    updateParserDebugView();
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e.target.error);
        reader.readAsText(file);
    });
}

// --- Live Directory Synchronizer (File System Access API) ---

async function scanDirectoryRecursive(dirHandle, currentPath = '') {
    let htmlEntries = [];
    let txtEntries = {};

    for await (const entry of dirHandle.values()) {
        const relativePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        const normalizedPath = relativePath.replace(/\\/g, '/');
        
        if (entry.kind === 'directory') {
            const subResults = await scanDirectoryRecursive(entry, normalizedPath);
            htmlEntries = htmlEntries.concat(subResults.htmlEntries);
            Object.assign(txtEntries, subResults.txtEntries);
        } else if (entry.kind === 'file') {
            if (entry.name.endsWith('.html')) {
                htmlEntries.push({ entry, relativePath: normalizedPath });
            } else if (entry.name.endsWith('.txt')) {
                const relativePathWithoutExt = normalizedPath.substring(0, normalizedPath.lastIndexOf('.'));
                const normalizedKey = relativePathWithoutExt.toLowerCase().trim();
                txtEntries[normalizedKey] = { entry, relativePath: normalizedPath };
            }
        }
    }
    return { htmlEntries, txtEntries };
}

async function syncDirectoryFiles() {
    if (!state.dirHandle) return;
    
    let folderUpdated = false;

    try {
        // Query read permission if not already granted
        const permission = await verifyPermission(state.dirHandle);
        if (!permission) {
            document.getElementById('scan-status-text').innerText = 'Access Denied';
            document.getElementById('scan-status').classList.remove('active');
            return;
        }

        document.getElementById('scan-status').classList.add('active');
        document.getElementById('scan-status-text').innerText = 'Live Syncing';

        // Scan directory recursively
        const { htmlEntries, txtEntries } = await scanDirectoryRecursive(state.dirHandle);

        const currentRelativePaths = new Set(htmlEntries.map(e => e.relativePath));

        // Detect deletions
        for (const relPath in state.loadedFiles) {
            if (!currentRelativePaths.has(relPath)) {
                delete state.loadedFiles[relPath];
                delete state.selectedFiles[relPath];
                folderUpdated = true;
            }
        }

        // Load new or updated files
        for (const htmlEntry of htmlEntries) {
            const relPath = htmlEntry.relativePath;
            const entry = htmlEntry.entry;
            const file = await entry.getFile();
            const lastModified = file.lastModified;

            // Look for matching TXT file
            const relPathWithoutExt = relPath.substring(0, relPath.lastIndexOf('.'));
            const normalizedKey = relPathWithoutExt.toLowerCase().trim();
            const txtEntryObj = txtEntries[normalizedKey];

            let txtLastModified = 0;
            let txtFile = null;
            if (txtEntryObj) {
                txtFile = await txtEntryObj.entry.getFile();
                txtLastModified = txtFile.lastModified;
            }

            const existingFile = state.loadedFiles[relPath];
            const txtModifiedChanged = existingFile && (existingFile.txtLastModified !== txtLastModified);

            if (!existingFile || existingFile.lastModified !== lastModified || txtModifiedChanged) {
                const text = await file.text();
                
                let answerKeyText = '';
                if (txtFile) {
                    answerKeyText = await txtFile.text();
                }

                const questions = QuizParser.parse(text, state.customSelectors, answerKeyText);
                
                state.loadedFiles[relPath] = {
                    filename: file.name,
                    relativePath: relPath,
                    content: text,
                    questions: questions,
                    lastModified: lastModified,
                    txtLastModified: txtLastModified,
                    answerKeyText: answerKeyText
                };

                // Default selection to false (unchecked) for new files
                if (!existingFile) {
                    state.selectedFiles[relPath] = false;
                }
                
                folderUpdated = true;
            }
        }

        if (folderUpdated) {
            renderFileList();
            updateCompiledQuestionCount();
            updateParserDebugView();
            showSyncToast();
        }
    } catch (e) {
        console.error('Error syncing files from folder:', e);
        document.getElementById('scan-status').classList.remove('active');
        document.getElementById('scan-status-text').innerText = 'Sync Error';
    }
}

// Verify directory handle read permission
async function verifyPermission(fileHandle) {
    const options = { mode: 'read' };
    if ((await fileHandle.queryPermission(options)) === 'granted') {
        return true;
    }
    if ((await fileHandle.requestPermission(options)) === 'granted') {
        return true;
    }
    return false;
}

// Background sync interval wrapper
async function backgroundFolderSync() {
    if (state.dirHandle && state.view !== 'quiz') {
        // Sync directory in the background if we're not inside an active quiz
        await syncDirectoryFiles();
    }
}

function showSyncToast() {
    // A subtle micro-notification for visual feedback
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '24px';
    toast.style.right = '24px';
    toast.style.background = 'rgba(99, 102, 241, 0.9)';
    toast.style.backdropFilter = 'blur(8px)';
    toast.style.border = '1px solid rgba(255,255,255,0.1)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.fontFamily = 'Inter, sans-serif';
    toast.style.fontSize = '13px';
    toast.style.fontWeight = '600';
    toast.style.zIndex = '999';
    toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
    toast.style.transform = 'translateY(100px)';
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    
    toast.innerText = 'Question banks synced successfully!';
    document.body.appendChild(toast);
    
    // Trigger animations
    setTimeout(() => {
        toast.style.transform = 'translateY(0)';
        toast.style.opacity = '1';
    }, 100);
    
    setTimeout(() => {
        toast.style.transform = 'translateY(100px)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- UI Builders ---

function buildDirectoryTree(files) {
    const root = { folders: {}, files: [] };
    
    for (const relativePath in files) {
        const fileObj = files[relativePath];
        const parts = relativePath.split('/');
        
        let current = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const folderName = parts[i];
            if (!current.folders[folderName]) {
                current.folders[folderName] = { folders: {}, files: [] };
            }
            current = current.folders[folderName];
        }
        
        const fileName = parts[parts.length - 1];
        current.files.push({
            name: fileName,
            relativePath: relativePath,
            fileObj: fileObj
        });
    }
    
    return root;
}

function renderFileList() {
    const listEl = document.getElementById('file-list');
    const relativePaths = Object.keys(state.loadedFiles);

    if (relativePaths.length === 0) {
        listEl.innerHTML = `<div class="no-files-card">Select a questions folder to load HTML files.</div>`;
        return;
    }

    listEl.innerHTML = '';
    const tree = buildDirectoryTree(state.loadedFiles);
    
    if (!state.collapsedFolders) {
        state.collapsedFolders = new Set();
    }

    function renderNode(node, container, currentDirPath = '') {
        // Sort folders naturally (ascending order, respecting numbers)
        const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        folderNames.forEach(folderName => {
            const folderPath = currentDirPath ? `${currentDirPath}/${folderName}` : folderName;
            const isCollapsed = state.collapsedFolders.has(folderPath);
            
            const folderEl = document.createElement('div');
            folderEl.className = `folder-node ${isCollapsed ? 'collapsed' : ''}`;
            
            const headerEl = document.createElement('div');
            headerEl.className = 'folder-header';
            headerEl.innerHTML = `
                <div class="folder-title-wrap">
                    <span class="folder-arrow">
                        <svg viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
                    </span>
                    <span class="folder-icon">
                        <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                    </span>
                    <span class="folder-name">${folderName}</span>
                </div>
            `;
            
            headerEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.collapsedFolders.has(folderPath)) {
                    state.collapsedFolders.delete(folderPath);
                    folderEl.classList.remove('collapsed');
                } else {
                    state.collapsedFolders.add(folderPath);
                    folderEl.classList.add('collapsed');
                }
            });
            
            const childrenEl = document.createElement('div');
            childrenEl.className = 'folder-children';
            
            folderEl.appendChild(headerEl);
            folderEl.appendChild(childrenEl);
            container.appendChild(folderEl);
            
            renderNode(node.folders[folderName], childrenEl, folderPath);
        });

        // Sort files naturally (ascending order, respecting numbers)
        const sortedFiles = node.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        sortedFiles.forEach(file => {
            const fileObj = file.fileObj;
            const count = fileObj.questions.length;
            const isChecked = state.selectedFiles[file.relativePath] ? 'checked' : '';
            
            const item = document.createElement('div');
            item.className = `file-item ${state.selectedFiles[file.relativePath] ? 'selected' : ''}`;
            
            const escapedPath = file.relativePath.replace(/'/g, "\\'");
            
            item.innerHTML = `
                <div class="file-info" onclick="toggleFileCheckbox('${escapedPath}')">
                    <input type="checkbox" class="file-checkbox" ${isChecked} onclick="event.stopPropagation(); toggleFileCheckbox('${escapedPath}')">
                    <div class="file-details">
                        <span class="file-name" title="${file.name}">${file.name}</span>
                        <span class="file-q-count">${count} questions parsed</span>
                    </div>
                </div>
                <div class="file-actions">
                    <button class="btn-icon" title="Preview parser data" onclick="event.stopPropagation(); debugFileParser('${escapedPath}')">
                        <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                    </button>
                </div>
            `;
            container.appendChild(item);
        });
    }

    renderNode(tree, listEl);
}

function toggleFileCheckbox(relativePath) {
    state.selectedFiles[relativePath] = !state.selectedFiles[relativePath];
    renderFileList();
    updateCompiledQuestionCount();
    updateSliderMax();
}

function debugFileParser(relativePath) {
    switchView('parser');
    const select = document.getElementById('parser-debug-file-select');
    select.value = relativePath;
    updateParserDebugView();
}

function updateCompiledQuestionCount() {
    const compiledCount = getCompiledQuestions().length;
    document.getElementById('total-compiled-count').innerText = compiledCount;
    document.getElementById('stat-total-q').innerText = compiledCount;
    document.getElementById('stat-files').innerText = Object.keys(state.loadedFiles).length;
}

function updateSliderMax() {
    const totalQ = getCompiledQuestions().length;
    const slider = document.getElementById('q-count-slider');
    
    if (totalQ > 0) {
        slider.max = totalQ;
        slider.min = Math.min(5, totalQ);
        slider.value = Math.min(20, totalQ);
    } else {
        slider.max = 50;
        slider.min = 5;
        slider.value = 20;
    }
    updateSliderDisplay();
}

function updateSliderDisplay() {
    const slider = document.getElementById('q-count-slider');
    const display = document.getElementById('q-count-display');
    const total = getCompiledQuestions().length;
    
    if (parseInt(slider.value) === total && total > 0) {
        display.innerText = `All (${total})`;
    } else {
        display.innerText = slider.value;
    }
}

// Compile all questions from currently checked files
function getCompiledQuestions() {
    let questions = [];
    for (const relativePath in state.loadedFiles) {
        if (state.selectedFiles[relativePath]) {
            questions = questions.concat(state.loadedFiles[relativePath].questions);
        }
    }
    return questions;
}

// --- Tab Navigation View Controller ---

function switchView(viewName) {
    if (state.view === 'quiz' && viewName !== 'quiz') {
        // Can't just switch view if quiz is active unless we confirm
        if (!confirm('Cancel active quiz session? Your current progress will be lost.')) {
            return;
        }
        cleanupActiveQuiz();
    }

    state.view = viewName;
    
    // Manage CSS classes on views
    document.querySelectorAll('.view-panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    
    const panel = document.getElementById(`view-${viewName}`);
    if (panel) panel.classList.add('active');
    
    const navItem = document.getElementById(`nav-${viewName}`);
    if (navItem) navItem.classList.add('active');

    // Title / Subtitle customization
    const titleEl = document.getElementById('page-title');
    const subtitleEl = document.getElementById('page-subtitle');

    if (viewName === 'dashboard') {
        titleEl.innerText = 'Dashboard';
        subtitleEl.innerText = 'Welcome to your exam study cockpit.';
        updateDashboardStats();
    } else if (viewName === 'quiz') {
        titleEl.innerText = 'Practice Session';
        subtitleEl.innerText = state.activeQuiz ? `Practicing: ${state.activeQuiz.mode === 'study' ? 'Study Mode (Self-check)' : 'Exam Mode (Timed)'}` : 'Exam in progress.';
    } else if (viewName === 'results') {
        titleEl.innerText = 'Performance Review';
        subtitleEl.innerText = 'Analyze correct/incorrect responses and build knowledge.';
    } else if (viewName === 'history') {
        titleEl.innerText = 'Practice History';
        subtitleEl.innerText = 'Review your past performance, accuracy metrics, and details.';
        renderDetailedHistory();
    } else if (viewName === 'parser') {
        titleEl.innerText = 'Selector Console';
        subtitleEl.innerText = 'Inspect HTML and tune compiler rules for complex web exports.';
        updateParserDebugView();
    }
}

// --- Parser Config Panel Logic ---

function loadSelectorsFromStorage() {
    const saved = localStorage.getItem('quizpro_selectors');
    if (saved) {
        try {
            state.customSelectors = JSON.parse(saved);
            document.getElementById('cfg-block-sel').value = state.customSelectors.questionBlockSelector;
            document.getElementById('cfg-text-sel').value = state.customSelectors.questionTextSelector;
            document.getElementById('cfg-option-sel').value = state.customSelectors.optionSelector;
            document.getElementById('cfg-correct-sel').value = state.customSelectors.correctIndicatorSelector;
            document.getElementById('cfg-explanation-sel').value = state.customSelectors.explanationSelector;
        } catch (e) {
            console.error('Error loading custom selectors:', e);
        }
    }
}

function applyParserSelectors() {
    state.customSelectors = {
        questionBlockSelector: document.getElementById('cfg-block-sel').value.trim(),
        questionTextSelector: document.getElementById('cfg-text-sel').value.trim(),
        optionSelector: document.getElementById('cfg-option-sel').value.trim(),
        correctIndicatorSelector: document.getElementById('cfg-correct-sel').value.trim(),
        explanationSelector: document.getElementById('cfg-explanation-sel').value.trim()
    };

    localStorage.setItem('quizpro_selectors', JSON.stringify(state.customSelectors));

    // Re-parse all loaded files with the new selectors
    let updated = false;
    for (const relativePath in state.loadedFiles) {
        const fileObj = state.loadedFiles[relativePath];
        // Pass fileObj.answerKeyText to ensure we don't lose the correct answers
        const newQuestions = QuizParser.parse(fileObj.content, state.customSelectors, fileObj.answerKeyText || '');
        fileObj.questions = newQuestions;
        updated = true;
    }

    if (updated) {
        renderFileList();
        updateCompiledQuestionCount();
        updateParserDebugView();
        alert('Selectors applied. All loaded files re-parsed.');
    }
}

function resetParserSelectors() {
    document.getElementById('cfg-block-sel').value = '';
    document.getElementById('cfg-text-sel').value = '';
    document.getElementById('cfg-option-sel').value = '';
    document.getElementById('cfg-correct-sel').value = '';
    document.getElementById('cfg-explanation-sel').value = '';
    
    applyParserSelectors();
}

function updateParserDebugView() {
    const select = document.getElementById('parser-debug-file-select');
    const htmlPreview = document.getElementById('parser-html-preview');
    const jsonPreview = document.getElementById('parser-json-preview');
    const countBadge = document.getElementById('parser-preview-count');

    // Re-populate select element
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Select File --</option>';
    
    Object.keys(state.loadedFiles).sort().forEach(relativePath => {
        const opt = document.createElement('option');
        opt.value = relativePath;
        opt.innerText = relativePath;
        select.appendChild(opt);
    });

    if (state.loadedFiles[currentValue]) {
        select.value = currentValue;
    }

    const targetFile = state.loadedFiles[select.value];
    if (targetFile) {
        // Show HTML preview
        htmlPreview.textContent = targetFile.content.substring(0, 5000) + (targetFile.content.length > 5000 ? '\n\n... [TRUNCATED] ...' : '');
        // Show JSON questions preview
        jsonPreview.textContent = JSON.stringify(targetFile.questions, null, 2);
        
        countBadge.style.display = 'inline-flex';
        countBadge.innerText = `${targetFile.questions.length} Questions Found`;
    } else {
        htmlPreview.textContent = 'Select an HTML file in the sidebar or connect a directory to preview raw HTML.';
        jsonPreview.textContent = 'Parsed questions JSON will appear here.';
        countBadge.style.display = 'none';
    }
}

// --- Active Quiz Controller ---

let selectedMode = 'study';

function selectPracticeMode(mode) {
    selectedMode = mode;
    document.getElementById('mode-study').classList.remove('selected');
    document.getElementById('mode-exam').classList.remove('selected');
    document.getElementById(`mode-${mode}`).classList.add('selected');

    if (mode === 'exam') {
        document.getElementById('timer-group').style.display = 'flex';
    } else {
        document.getElementById('timer-group').style.display = 'none';
    }
}

function startQuizHandler() {
    const questions = getCompiledQuestions();
    const warning = document.getElementById('setup-no-q-warning');
    
    if (questions.length === 0) {
        warning.style.display = 'block';
        return;
    }
    warning.style.display = 'none';

    // Settings
    const sliderValue = parseInt(document.getElementById('q-count-slider').value);
    const timeLimitMinutes = parseInt(document.getElementById('quiz-duration-select').value);

    // Shuffle and pick
    const shouldShuffle = document.getElementById('shuffle-questions-checkbox').checked;
    let selectedQuestions = [...questions];
    if (shouldShuffle) {
        selectedQuestions.sort(() => 0.5 - Math.random());
    }
    selectedQuestions = selectedQuestions.slice(0, Math.min(sliderValue, selectedQuestions.length));

    // Deep clone the questions to prevent modifying the original questions in state.loadedFiles
    selectedQuestions = selectedQuestions.map(q => {
        return {
            ...q,
            options: [...q.options]
        };
    });

    // Shuffle options if checked
    const shouldShuffleOptions = document.getElementById('shuffle-options-checkbox').checked;
    if (shouldShuffleOptions) {
        selectedQuestions.forEach(q => {
            if (!q.isFIB && q.options.length > 1) {
                const correctOptText = q.correctAnswerIndex !== -1 ? q.options[q.correctAnswerIndex] : null;
                
                // Fisher-Yates shuffle
                for (let i = q.options.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [q.options[i], q.options[j]] = [q.options[j], q.options[i]];
                }
                
                if (correctOptText !== null) {
                    q.correctAnswerIndex = q.options.indexOf(correctOptText);
                }
            }
        });
    }

    // Initialize Quiz
    state.activeQuiz = new ActiveQuiz(selectedQuestions, selectedMode, timeLimitMinutes);

    // Setup active state in UI
    document.getElementById('nav-quiz').style.display = 'flex';
    switchView('quiz');
    
    // Init Timer if exam mode
    const timerDisplay = document.getElementById('quiz-timer-display');
    if (selectedMode === 'exam') {
        timerDisplay.style.display = 'block';
        timerDisplay.innerText = formatTime(state.activeQuiz.timeRemaining);
        
        state.activeQuiz.timerId = setInterval(() => {
            state.activeQuiz.timeRemaining--;
            timerDisplay.innerText = formatTime(state.activeQuiz.timeRemaining);
            
            if (state.activeQuiz.timeRemaining <= 0) {
                clearInterval(state.activeQuiz.timerId);
                alert('Time is up! Submitting your answers.');
                submitQuiz();
            }
        }, 1000);
    } else {
        timerDisplay.style.display = 'none';
    }

    renderQuizQuestion();
    renderQuizGrid();
}

function renderQuizQuestion() {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    const q = quiz.questions[quiz.currentIdx];
    
    // UI elements
    document.getElementById('current-q-num').innerText = quiz.currentIdx + 1;
    document.getElementById('total-q-num').innerText = quiz.questions.length;
    document.getElementById('quiz-progress-fill').style.width = `${((quiz.currentIdx + 1) / quiz.questions.length) * 100}%`;
    document.getElementById('question-text').innerHTML = q.questionText;

    // Render Options
    const optList = document.getElementById('options-list');
    optList.innerHTML = '';

    const isAnswered = quiz.answers[quiz.currentIdx] !== undefined && quiz.answers[quiz.currentIdx].toString().trim() !== '';
    const isChecked = quiz.checked[quiz.currentIdx] === true;

    if (q.isFIB) {
        // Render Fill-in-the-blank input field
        const fibContainer = document.createElement('div');
        fibContainer.style.display = 'flex';
        fibContainer.style.flexDirection = 'column';
        fibContainer.style.gap = '12px';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'custom-input';
        input.placeholder = 'Type your answer here...';
        input.style.fontSize = '16px';
        input.style.padding = '16px 20px';
        input.style.width = '100%';
        input.style.borderRadius = 'var(--radius-md)';
        input.style.border = '1px solid var(--border-color)';
        input.style.background = 'rgba(0, 0, 0, 0.2)';
        input.style.color = '#fff';
        input.style.outline = 'none';
        input.style.transition = 'all 0.3s';

        // Set previous answer if already typed
        if (quiz.answers[quiz.currentIdx] !== undefined) {
            input.value = quiz.answers[quiz.currentIdx];
        }

        // Disable input if checked in study mode
        if (quiz.mode === 'study' && isChecked) {
            input.disabled = true;
            
            // Check if correct
            const userText = quiz.answers[quiz.currentIdx] || '';
            const correctVal = q.options[q.correctAnswerIndex] || q.options[0] || '';
            const isCorrect = normalizeFIBAnswer(userText) === normalizeFIBAnswer(correctVal);

            if (isCorrect) {
                input.style.borderColor = 'var(--success)';
                input.style.boxShadow = '0 0 10px var(--success-glow)';
                input.style.background = 'rgba(16, 185, 129, 0.05)';
            } else {
                input.style.borderColor = 'var(--danger)';
                input.style.boxShadow = '0 0 10px var(--danger-glow)';
                input.style.background = 'rgba(244, 63, 94, 0.05)';

                // Show correct answer indicator below it
                const helperText = document.createElement('div');
                helperText.style.color = '#f87171';
                helperText.style.fontSize = '14px';
                helperText.style.fontWeight = '600';
                helperText.style.marginTop = '4px';
                helperText.innerHTML = `Correct Answer: <span style="color:#10b981">${correctVal}</span>`;
                fibContainer.appendChild(helperText);
            }
        }

        // Handle value changes
        input.addEventListener('input', (e) => {
            quiz.answers[quiz.currentIdx] = e.target.value;
            updateQuizGridDotStatus(quiz.currentIdx);
            updateQuizNavButtons();
        });

        fibContainer.appendChild(input);
        optList.appendChild(fibContainer);

    } else {
        // Standard MCQ Options
        q.options.forEach((optText, optIdx) => {
            const item = document.createElement('div');
            item.className = 'option-card-item';
            
            const letter = String.fromCharCode(65 + optIdx); // A, B, C, D
            item.innerHTML = `
                <div class="option-letter">${letter}</div>
                <div class="option-text-val">${optText}</div>
            `;

            // Highlight if selected
            if (quiz.answers[quiz.currentIdx] === optIdx) {
                item.classList.add('selected');
            }

            // Apply feedback styles in study mode if checked
            if (quiz.mode === 'study' && isChecked) {
                if (optIdx === q.correctAnswerIndex) {
                    item.classList.add('correct');
                } else if (quiz.answers[quiz.currentIdx] === optIdx) {
                    item.classList.add('incorrect');
                }
            }

            // Option click handler
            item.addEventListener('click', () => {
                if (quiz.mode === 'study' && isChecked) return; // Can't change after check in study mode
                selectQuizOption(optIdx);
            });

            optList.appendChild(item);
        });
    }

    // Check explanation card (study mode only)
    const expCard = document.getElementById('explanation-card');
    const expTextContent = document.getElementById('explanation-text-content');
    
    if (quiz.mode === 'study' && isChecked) {
        expCard.style.display = 'block';
        expTextContent.innerHTML = q.explanation || 'No explanation provided for this question.';
    } else {
        expCard.style.display = 'none';
    }

    // Toggle nav controls
    document.getElementById('btn-prev-q').disabled = quiz.currentIdx === 0;
    updateQuizNavButtons();

    // Flag button visual update
    const flagBtn = document.getElementById('btn-flag-q');
    if (quiz.flagged[quiz.currentIdx]) {
        flagBtn.style.background = 'rgba(245, 158, 11, 0.15)';
        flagBtn.style.borderColor = 'var(--warning)';
    } else {
        flagBtn.style.background = '';
        flagBtn.style.borderColor = '';
    }
}

function selectQuizOption(optIdx) {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    quiz.answers[quiz.currentIdx] = optIdx;
    
    // Redraw
    renderQuizQuestion();
    renderQuizGrid();
}

function checkAnswer() {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    quiz.checked[quiz.currentIdx] = true;
    renderQuizQuestion();
}

function prevQuestion() {
    const quiz = state.activeQuiz;
    if (!quiz || quiz.currentIdx === 0) return;
    
    quiz.currentIdx--;
    renderQuizQuestion();
    renderQuizGrid();
}

function nextQuestion() {
    const quiz = state.activeQuiz;
    if (!quiz || quiz.currentIdx === quiz.questions.length - 1) return;

    quiz.currentIdx++;
    renderQuizQuestion();
    renderQuizGrid();
}

function toggleFlagQuestion() {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    quiz.flagged[quiz.currentIdx] = !quiz.flagged[quiz.currentIdx];
    renderQuizQuestion();
    renderQuizGrid();
}

function renderQuizGrid() {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    const grid = document.getElementById('question-grid');
    grid.innerHTML = '';

    quiz.questions.forEach((_, idx) => {
        const dot = document.createElement('button');
        dot.className = 'nav-grid-dot';
        dot.innerText = idx + 1;

        if (idx === quiz.currentIdx) {
            dot.classList.add('current');
        } else if (quiz.flagged[idx]) {
            dot.classList.add('flagged');
        } else if (quiz.answers[idx] !== undefined && quiz.answers[idx].toString().trim() !== '') {
            dot.classList.add('answered');
        }

        dot.addEventListener('click', () => {
            quiz.currentIdx = idx;
            renderQuizQuestion();
            renderQuizGrid();
        });

        grid.appendChild(dot);
    });
}

function updateQuizGridDotStatus(idx) {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    const dots = document.getElementById('question-grid').children;
    if (dots && dots[idx]) {
        const dot = dots[idx];
        dot.className = 'nav-grid-dot';
        if (idx === quiz.currentIdx) {
            dot.classList.add('current');
        } else if (quiz.flagged[idx]) {
            dot.classList.add('flagged');
        } else if (quiz.answers[idx] !== undefined && quiz.answers[idx].toString().trim() !== '') {
            dot.classList.add('answered');
        }
    }
}

function updateQuizNavButtons() {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    const isAnswered = quiz.answers[quiz.currentIdx] !== undefined && quiz.answers[quiz.currentIdx].toString().trim() !== '';
    const isChecked = quiz.checked[quiz.currentIdx] === true;

    const checkBtn = document.getElementById('btn-check-q');
    const nextBtn = document.getElementById('btn-next-q');
    const submitBtn = document.getElementById('btn-submit-quiz');

    if (quiz.mode === 'study') {
        if (isAnswered && !isChecked) {
            checkBtn.style.display = 'block';
            nextBtn.style.display = 'none';
        } else {
            checkBtn.style.display = 'none';
            // Show submit if it's the last question
            if (quiz.currentIdx === quiz.questions.length - 1) {
                nextBtn.style.display = 'none';
                submitBtn.style.display = 'block';
            } else {
                nextBtn.style.display = 'block';
                submitBtn.style.display = 'none';
            }
        }
    } else {
        // Exam mode: no checking answers
        checkBtn.style.display = 'none';
        if (quiz.currentIdx === quiz.questions.length - 1) {
            nextBtn.style.display = 'none';
            submitBtn.style.display = 'block';
        } else {
            nextBtn.style.display = 'block';
            submitBtn.style.display = 'none';
        }
    }
}

function submitQuizHandler() {
    if (confirm('Are you sure you want to submit your quiz?')) {
        submitQuiz();
    }
}

function quitQuizHandler() {
    if (confirm('Quit active quiz? Your scores will not be recorded.')) {
        cleanupActiveQuiz();
        switchView('dashboard');
    }
}

function cleanupActiveQuiz() {
    if (state.activeQuiz && state.activeQuiz.timerId) {
        clearInterval(state.activeQuiz.timerId);
    }
    state.activeQuiz = null;
    document.getElementById('nav-quiz').style.display = 'none';
}

function submitQuiz() {
    const quiz = state.activeQuiz;
    if (!quiz) return;

    // Terminate timer
    if (quiz.timerId) clearInterval(quiz.timerId);

    // Calculate score
    let correctCount = 0;
    let incorrectCount = 0;

    quiz.questions.forEach((q, idx) => {
        const userAns = quiz.answers[idx];
        if (userAns === undefined || userAns === null || userAns.toString().trim() === '') {
            incorrectCount++;
            return;
        }

        if (q.isFIB) {
            const correctVal = q.options[q.correctAnswerIndex] || q.options[0] || '';
            if (normalizeFIBAnswer(userAns) === normalizeFIBAnswer(correctVal)) {
                correctCount++;
            } else {
                incorrectCount++;
            }
        } else {
            if (userAns === q.correctAnswerIndex) {
                correctCount++;
            } else {
                incorrectCount++;
            }
        }
    });

    const total = quiz.questions.length;
    const percentage = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    const timeSpent = Math.round((Date.now() - quiz.startTime) / 1000); // seconds

    // Save record to history
    const record = {
        id: `session-${Date.now()}`,
        date: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        score: correctCount,
        total: total,
        percentage: percentage,
        mode: quiz.mode === 'study' ? 'Study' : 'Exam',
        timeSpent: timeSpent
    };

    state.history.unshift(record);
    localStorage.setItem('quizpro_history', JSON.stringify(state.history));

    // Show Results Panel
    renderResults(quiz, correctCount, incorrectCount, timeSpent, percentage);
    
    // Reset active quiz
    cleanupActiveQuiz();
    
    switchView('results');
}

// --- Results View Controller ---

function renderResults(quiz, correct, incorrect, timeSpent, percentage) {
    document.getElementById('results-correct-count').innerText = correct;
    document.getElementById('results-incorrect-count').innerText = incorrect;
    document.getElementById('results-percentage').innerText = `${percentage}%`;
    document.getElementById('results-time-taken').innerText = formatTimeSpent(timeSpent);

    // Dynamic Ring Gauge fill
    const fillRing = document.getElementById('results-circle-fill');
    const offset = 440 - (440 * percentage) / 100;
    fillRing.style.strokeDashoffset = offset;

    // Grade Text
    const gradeText = document.getElementById('results-grade');
    const summaryText = document.getElementById('results-summary-text');
    
    summaryText.innerText = `You answered ${correct} out of ${quiz.questions.length} questions correctly.`;

    if (percentage >= 90) {
        gradeText.innerText = 'Excellent Performance!';
        gradeText.style.color = 'var(--success)';
    } else if (percentage >= 70) {
        gradeText.innerText = 'Well Done!';
        gradeText.style.color = '#a5b4fc';
    } else if (percentage >= 50) {
        gradeText.innerText = 'Keep Practicing!';
        gradeText.style.color = 'var(--warning)';
    } else {
        gradeText.innerText = 'Don\'t Give Up!';
        gradeText.style.color = 'var(--danger)';
    }

    // Render detailed questions review
    const reviewList = document.getElementById('review-list');
    reviewList.innerHTML = '';

    quiz.questions.forEach((q, idx) => {
        const userAns = quiz.answers[idx];
        let isCorrect = false;
        
        if (userAns !== undefined && userAns !== null && userAns.toString().trim() !== '') {
            if (q.isFIB) {
                const correctVal = q.options[q.correctAnswerIndex] || q.options[0] || '';
                isCorrect = normalizeFIBAnswer(userAns) === normalizeFIBAnswer(correctVal);
            } else {
                isCorrect = userAns === q.correctAnswerIndex;
            }
        }
        
        const card = document.createElement('div');
        card.className = `review-item-card ${isCorrect ? 'correct' : 'incorrect'}`;

        const badgeText = isCorrect ? 'Correct' : 'Incorrect';
        const badgeClass = isCorrect ? 'correct' : 'incorrect';

        let optionsHtml = '';
        if (q.isFIB) {
            const correctVal = q.options[q.correctAnswerIndex] || q.options[0] || '';
            const userTyped = userAns || '[No answer entered]';
            optionsHtml = `
                <div class="review-opt ${isCorrect ? 'selected-correct' : 'selected-incorrect'}" style="margin-bottom:8px;">
                    <strong>Your Response:</strong> ${userTyped}
                </div>
                <div class="review-opt actual-correct">
                    <strong>Correct Answer:</strong> ${correctVal}
                </div>
            `;
        } else {
            q.options.forEach((opt, optIdx) => {
                let optClass = 'review-opt';
                if (optIdx === q.correctAnswerIndex) {
                    optClass += ' actual-correct';
                }
                if (userAns === optIdx) {
                    optClass += isCorrect ? ' selected-correct' : ' selected-incorrect';
                }

                const letter = String.fromCharCode(65 + optIdx);
                optionsHtml += `
                    <div class="${optClass}" style="margin-bottom:6px;">
                        <strong>${letter}</strong> ${opt}
                    </div>
                `;
            });
        }

        card.innerHTML = `
            <div class="review-q-header">
                <div class="review-q-text">Question ${idx + 1}: ${q.questionText}</div>
                <span class="review-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="review-options-list">
                ${optionsHtml}
            </div>
            <div class="explanation-card" style="display: block; margin-top: 10px; padding: 14px;">
                <div class="explanation-title" style="font-size: 11px;">Explanation</div>
                <div class="explanation-text" style="font-size: 13px;">${q.explanation || 'No explanation provided.'}</div>
            </div>
        `;

        reviewList.appendChild(card);
    });
}

// --- History & Dashboard Stats ---

function loadHistory() {
    const saved = localStorage.getItem('quizpro_history');
    if (saved) {
        try {
            state.history = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to parse history:', e);
            state.history = [];
        }
    }
}

function renderHistory() {
    const list = document.getElementById('activity-log');
    if (state.history.length === 0) {
        list.innerHTML = `<div class="no-files-card" style="margin: 0; border-style: solid;">No quizzes completed yet. Your achievements will be recorded here!</div>`;
        return;
    }

    list.innerHTML = '';
    state.history.slice(0, 10).forEach(item => {
        const isPass = item.percentage >= 70;
        const itemDiv = document.createElement('div');
        itemDiv.className = 'history-item';
        
        itemDiv.innerHTML = `
            <div class="history-meta">
                <span class="history-title">${item.score}/${item.total} Questions (${item.percentage}%)</span>
                <span class="history-date">${item.date} • ${item.mode} Mode</span>
            </div>
            <span class="history-badge ${isPass ? 'pass' : 'fail'}">${isPass ? 'PASS' : 'FAIL'}</span>
        `;
        list.appendChild(itemDiv);
    });
}

function updateDashboardStats() {
    document.getElementById('stat-sessions').innerText = state.history.length;
    
    if (state.history.length > 0) {
        let sum = 0;
        state.history.forEach(h => sum += h.percentage);
        const avg = Math.round(sum / state.history.length);
        document.getElementById('stat-accuracy').innerText = `${avg}%`;
        
        const accuracyCard = document.getElementById('stat-accuracy').parentElement;
        if (avg >= 75) {
            accuracyCard.classList.remove('rose', 'warning');
            accuracyCard.classList.add('emerald');
        } else if (avg >= 50) {
            accuracyCard.classList.remove('emerald', 'rose');
            accuracyCard.classList.add('warning');
        } else {
            accuracyCard.classList.remove('emerald', 'warning');
            accuracyCard.classList.add('rose');
        }
    } else {
        document.getElementById('stat-accuracy').innerText = '0%';
    }
    
    renderHistory();
}

function normalizeFIBAnswer(text) {
    if (text === undefined || text === null) return '';
    return text.toString()
        .toLowerCase()
        .replace(/&nbsp;/gi, ' ')
        .replace(/Â/g, '')
        .replace(/[\s\u00a0\u200b\u00c2]+/g, ' ')
        .trim();
}

function renderDetailedHistory() {
    const listEl = document.getElementById('history-detailed-list');
    const totalEl = document.getElementById('history-stat-total');
    const accuracyEl = document.getElementById('history-stat-accuracy');
    const timeEl = document.getElementById('history-stat-time');
    const ratioEl = document.getElementById('history-stat-ratio');

    const history = state.history;

    // Calculate stats
    const total = history.length;
    totalEl.innerText = total;

    if (total > 0) {
        let sumAccuracy = 0;
        let totalTime = 0;
        let studyCount = 0;
        let examCount = 0;

        history.forEach(item => {
            sumAccuracy += item.percentage;
            totalTime += (item.timeSpent || 0);
            if (item.mode && item.mode.toLowerCase() === 'study') {
                studyCount++;
            } else {
                examCount++;
            }
        });

        const avgAccuracy = Math.round(sumAccuracy / total);
        accuracyEl.innerText = `${avgAccuracy}%`;

        // Style the accuracy stat card
        const accuracyCard = accuracyEl.parentElement;
        accuracyCard.className = 'stat-card';
        if (avgAccuracy >= 75) {
            accuracyCard.classList.add('emerald');
        } else if (avgAccuracy >= 50) {
            accuracyCard.classList.add('warning');
        } else {
            accuracyCard.classList.add('rose');
        }

        // Format total time practiced
        timeEl.innerText = formatTotalTime(totalTime);
        ratioEl.innerText = `${studyCount} S / ${examCount} E`;
        ratioEl.title = `Study Mode sessions: ${studyCount}, Exam Mode sessions: ${examCount}`;
    } else {
        accuracyEl.innerText = '0%';
        timeEl.innerText = '0s';
        ratioEl.innerText = '0 S / 0 E';
        accuracyEl.parentElement.className = 'stat-card emerald';
    }

    // Render detailed cards list
    if (total === 0) {
        listEl.innerHTML = `
            <div class="no-files-card" style="margin: 0; border-style: solid;">
                You haven't completed any quizzes yet. Start practicing and your scores will appear here!
            </div>
        `;
        return;
    }

    listEl.innerHTML = '';
    history.forEach(item => {
        const isPass = item.percentage >= 70;
        const card = document.createElement('div');
        card.className = `history-card ${isPass ? 'pass' : 'fail'}`;

        card.innerHTML = `
            <div class="history-card-left">
                <div class="history-card-score">${item.score} / ${item.total} Correct (${item.percentage}%)</div>
                <div class="history-card-meta">
                    <span>${item.date}</span>
                    <span>•</span>
                    <span>${item.mode} Mode</span>
                    <span>•</span>
                    <span>Time Taken: ${formatTimeSpent(item.timeSpent || 0)}</span>
                </div>
            </div>
            <div class="history-card-right">
                <span class="history-badge ${isPass ? 'pass' : 'fail'}">${isPass ? 'PASS' : 'FAIL'}</span>
                <button class="btn-delete-history" onclick="deleteHistoryItem('${item.id}')" title="Delete record">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    Delete
                </button>
            </div>
        `;
        listEl.appendChild(card);
    });
}

function formatTotalTime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) {
        const s = seconds % 60;
        return `${m}m ${s}s`;
    }
    const h = Math.floor(m / 60);
    const mRem = m % 60;
    return `${h}h ${mRem}m`;
}

function deleteHistoryItem(id) {
    if (confirm('Are you sure you want to delete this practice record?')) {
        state.history = state.history.filter(item => item.id !== id);
        localStorage.setItem('quizpro_history', JSON.stringify(state.history));
        
        // Refresh views
        renderDetailedHistory();
        updateDashboardStats();
    }
}

function clearAllHistory() {
    if (confirm('WARNING: This will permanently delete ALL your quiz history. Are you sure you want to proceed?')) {
        state.history = [];
        localStorage.setItem('quizpro_history', JSON.stringify([]));
        
        // Refresh views
        renderDetailedHistory();
        updateDashboardStats();
    }
}

// --- Utilities ---

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatTimeSpent(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}
