document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperResponseTargetSelect = document.getElementById('whisperResponseTarget');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const geminiKeyInput = document.getElementById('geminiKey');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');
    const lockCursorShapeInput = document.getElementById('lockCursorShape');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button: exactly one request, then the button is disabled.
    //
    // This previously fired BOTH window.api.send('quit-app') and
    // window.electronAPI.quit() — which went to the same channel — and then
    // called window.close() on a timer. The main process ran a full shutdown
    // for each message and each scheduled its own process.exit(), so the two
    // teardowns raced and could kill the process mid-cleanup, stranding
    // helper processes. One click must mean one quit.
    if (quitButton) {
        let quitRequested = false;

        quitButton.addEventListener('click', async () => {
            if (quitRequested) return;
            quitRequested = true;

            quitButton.disabled = true;
            quitButton.style.opacity = '0.6';
            quitButton.style.cursor = 'default';
            quitButton.innerHTML = '<i class="fas fa-power-off"></i> Quitting…';

            try {
                await window.electronAPI.quit();
            } catch (error) {
                // The IPC channel usually just tears down as the app exits;
                // only re-enable if the app is somehow still alive.
                console.error('Quit request failed:', error);
                quitRequested = false;
                quitButton.disabled = false;
                quitButton.style.opacity = '';
                quitButton.style.cursor = '';
                quitButton.innerHTML = '<i class="fas fa-power-off"></i> Quit';
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperResponseTargetSelect) whisperResponseTargetSelect.value = settings.whisperResponseTarget || 'both';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        if (geminiKeyInput) geminiKeyInput.value = settings.geminiKey || '';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';

        // Cursor lock is a real boolean from getSettings(). Guard against a
        // save that is still in flight so a refresh cannot clobber the value
        // the user just chose.
        if (lockCursorShapeInput && !lockCursorShapeInput.dataset.saving) {
            lockCursorShapeInput.checked = settings.lockCursorShape === true;
        }

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperResponseTargetSelect) settings.whisperResponseTarget = whisperResponseTargetSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        
        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperResponseTargetSelect, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperResponseTargetSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ── Cursor-shape privacy ──────────────────────────────────────────
    //
    // Saves through the existing invoke-based settings API rather than a
    // cursor-specific IPC channel. The main process owns the setting, persists
    // it, and pushes it to every window.

    if (lockCursorShapeInput) {
        const noteEl = document.getElementById('lockCursorShapeNote');
        const baseNote = noteEl ? noteEl.textContent : '';
        let noteTimer = null;

        const showCursorError = (message) => {
            console.error('Lock cursor to arrow:', message);
            if (!noteEl) return;
            noteEl.textContent = `Could not save this setting: ${message}`;
            noteEl.style.color = 'rgb(255, 145, 138)';
            if (noteTimer) clearTimeout(noteTimer);
            noteTimer = setTimeout(() => {
                noteEl.textContent = baseNote;
                noteEl.style.color = '';
            }, 6000);
        };

        lockCursorShapeInput.addEventListener('change', async (e) => {
            // Guard against overlapping saves (rapid toggling).
            if (lockCursorShapeInput.dataset.saving) return;

            const desired = e.target.checked === true;
            const previous = !desired;

            lockCursorShapeInput.dataset.saving = '1';
            lockCursorShapeInput.disabled = true;

            try {
                // Send an actual boolean; the main process rejects anything else.
                const result = await window.electronAPI.saveSettings({
                    lockCursorShape: desired
                });

                if (result && result.success === false) {
                    // Never leave the UI showing a value that was not applied.
                    lockCursorShapeInput.checked = previous;
                    showCursorError(result.error || 'unknown error');
                }
            } catch (error) {
                lockCursorShapeInput.checked = previous;
                showCursorError((error && error.message) || 'settings channel unavailable');
            } finally {
                delete lockCursorShapeInput.dataset.saving;
                lockCursorShapeInput.disabled = false;
            }
        });
    }

    // ── macOS permissions ─────────────────────────────────────────────
    //
    // Status is only ever *read* here. The microphone prompt is fired solely
    // from the Allow button (a direct user action), and Screen Recording has
    // no request API at all — macOS raises that prompt the first time the app
    // actually captures, which is left exactly as it was.

    const permissionsSection = document.getElementById('permissionsSection');
    const screenStatusEl = document.getElementById('screenStatus');
    const micStatusEl = document.getElementById('micStatus');
    const screenRestartHint = document.getElementById('screenRestartHint');
    const screenSettingsBtn = document.getElementById('screenSettingsBtn');
    const micAllowBtn = document.getElementById('micAllowBtn');
    const micSettingsBtn = document.getElementById('micSettingsBtn');
    const permRefreshBtn = document.getElementById('permRefreshBtn');

    const STATUS_LABELS = {
        'granted': 'Granted',
        'denied': 'Denied',
        'restricted': 'Restricted',
        'not-determined': 'Not Set',
        'unknown': 'Unknown'
    };

    const STATUS_CLASSES = {
        'granted': 'is-granted',
        'denied': 'is-denied',
        'restricted': 'is-restricted',
        'not-determined': 'is-pending',
        'unknown': 'is-unknown'
    };

    const paintPill = (el, status, labelOverride) => {
        if (!el) return;
        el.textContent = labelOverride || STATUS_LABELS[status] || 'Unknown';
        el.className = `status-pill ${STATUS_CLASSES[status] || 'is-unknown'}`;
    };

    const renderPermissions = (snapshot) => {
        if (!snapshot || !snapshot.supported) {
            if (permissionsSection) permissionsSection.style.display = 'none';
            return;
        }
        if (permissionsSection) permissionsSection.style.display = '';

        const screen = snapshot.screen || {};
        const mic = snapshot.microphone || {};

        paintPill(screenStatusEl, screen.status);
        paintPill(micStatusEl, mic.status);

        // Screen Recording grants are only picked up by a process that
        // starts *after* the grant, so say so rather than letting the user
        // wonder why capture still fails.
        if (screenRestartHint) {
            screenRestartHint.style.display =
                screen.status === 'granted' ? 'none' : '';
        }

        // Once macOS has recorded a decision the prompt can never appear
        // again — System Settings is the only remaining route.
        if (micAllowBtn) {
            const canPrompt = mic.status === 'not-determined';
            micAllowBtn.style.display = canPrompt ? '' : 'none';
            micAllowBtn.disabled = !canPrompt;
        }
    };

    const refreshPermissions = async () => {
        if (!window.electronAPI || !window.electronAPI.getPermissionStatus) return;
        try {
            renderPermissions(await window.electronAPI.getPermissionStatus());
        } catch (error) {
            console.error('Failed to read permission status:', error);
            paintPill(screenStatusEl, 'unknown');
            paintPill(micStatusEl, 'unknown');
        }
    };

    if (permRefreshBtn) {
        permRefreshBtn.addEventListener('click', refreshPermissions);
    }

    if (screenSettingsBtn) {
        screenSettingsBtn.addEventListener('click', () => {
            window.electronAPI.openPermissionSettings('screen');
        });
    }

    if (micSettingsBtn) {
        micSettingsBtn.addEventListener('click', () => {
            window.electronAPI.openPermissionSettings('microphone');
        });
    }

    if (micAllowBtn) {
        micAllowBtn.addEventListener('click', async () => {
            micAllowBtn.disabled = true;
            try {
                const result = await window.electronAPI.requestMicrophoneAccess();
                if (result && result.needsSystemSettings) {
                    await window.electronAPI.openPermissionSettings('microphone');
                }
            } catch (error) {
                console.error('Microphone request failed:', error);
            } finally {
                refreshPermissions();
            }
        });
    }

    // ── Updates ───────────────────────────────────────────────────────

    const updatesSection = document.getElementById('updatesSection');
    const updateStatusEl = document.getElementById('updateStatus');
    const updateDetailEl = document.getElementById('updateDetail');
    const updateCheckBtn = document.getElementById('updateCheckBtn');
    const updateInstallBtn = document.getElementById('updateInstallBtn');
    const updateProgressTrack = document.getElementById('updateProgressTrack');
    const updateProgressFill = document.getElementById('updateProgressFill');

    const UPDATE_LABELS = {
        'idle': ['Idle', 'is-pending'],
        'checking': ['Checking', 'is-pending'],
        'downloading': ['Downloading', 'is-pending'],
        'downloaded': ['Ready', 'is-granted'],
        'not-available': ['Up to date', 'is-granted'],
        'error': ['Error', 'is-error']
    };

    const renderUpdateState = (state) => {
        if (!state) return;

        const [label, cls] = UPDATE_LABELS[state.state] || ['Unknown', 'is-unknown'];
        if (updateStatusEl) {
            updateStatusEl.textContent = label;
            updateStatusEl.className = `status-pill ${cls}`;
        }

        if (updateDetailEl) {
            const current = state.currentVersion ? `Version ${state.currentVersion}` : 'Version unknown';
            let detail;

            if (!state.enabled) {
                detail = `${current} — updates are only available in the installed macOS app`;
            } else if (state.state === 'error') {
                detail = state.error || 'Update check failed';
            } else if (state.state === 'downloaded') {
                detail = `${current} — ${state.availableVersion} is ready to install`;
            } else if (state.state === 'downloading') {
                detail = `${current} — downloading ${state.availableVersion} (${state.percent}%)`;
            } else if (state.state === 'not-available') {
                detail = `${current} — you're on the latest version`;
            } else if (state.lastCheckAt) {
                const when = new Date(state.lastCheckAt);
                detail = `${current} — last checked ${when.toLocaleTimeString()}`;
            } else {
                detail = current;
            }
            updateDetailEl.textContent = detail;
        }

        const downloading = state.state === 'downloading';
        if (updateProgressTrack) updateProgressTrack.style.display = downloading ? '' : 'none';
        if (updateProgressFill) updateProgressFill.style.width = `${state.percent || 0}%`;

        if (updateInstallBtn) {
            updateInstallBtn.style.display = state.canInstall ? '' : 'none';
        }
        if (updateCheckBtn) {
            updateCheckBtn.disabled = !state.enabled || state.state === 'checking' || downloading;
        }
    };

    const refreshUpdateState = async () => {
        if (!window.electronAPI || !window.electronAPI.getUpdateState) {
            if (updatesSection) updatesSection.style.display = 'none';
            return;
        }
        try {
            renderUpdateState(await window.electronAPI.getUpdateState());
        } catch (error) {
            console.error('Failed to read update state:', error);
        }
    };

    if (updateCheckBtn) {
        updateCheckBtn.addEventListener('click', async () => {
            updateCheckBtn.disabled = true;
            try {
                renderUpdateState(await window.electronAPI.checkForUpdates());
            } catch (error) {
                console.error('Update check failed:', error);
            } finally {
                refreshUpdateState();
            }
        });
    }

    if (updateInstallBtn) {
        updateInstallBtn.addEventListener('click', async () => {
            updateInstallBtn.disabled = true;
            try {
                const result = await window.electronAPI.installUpdate();
                if (result && !result.success) {
                    console.error('Install refused:', result.error);
                    updateInstallBtn.disabled = false;
                }
            } catch (error) {
                console.error('Install failed:', error);
                updateInstallBtn.disabled = false;
            }
        });
    }

    // Live progress pushed from the main process.
    if (window.electronAPI && window.electronAPI.onUpdateState) {
        window.electronAPI.onUpdateState(renderUpdateState);
    }

    refreshPermissions();
    refreshUpdateState();

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
