/** Export-only manual correction. Intentionally reset for each new export session. */
const defaults = {
    brightness: 0, gamma: 1, contrast: 1, saturation: 1,
    red: 0, green: 0, blue: 0, denoise: 0, sharpen: 0
};
const byId = id => document.getElementById(id);

export function getQualityAdjustment() {
    const result = { enabled: byId('qualityAdjustmentEnabled')?.checked === true };
    for (const [key, fallback] of Object.entries(defaults)) {
        const value = Number(byId(`qualityAdjustment-${key}`)?.value);
        result[key] = Number.isFinite(value) ? value : fallback;
    }
    return result;
}

export function initQualityAdjustmentControls() {
    const enabled = byId('qualityAdjustmentEnabled');
    const fields = byId('qualityAdjustmentFields');
    if (!enabled || !fields) return;
    const refresh = () => { fields.disabled = !enabled.checked; };
    const reset = () => {
        enabled.checked = false;
        for (const [key, value] of Object.entries(defaults)) {
            const input = byId(`qualityAdjustment-${key}`);
            if (input) input.value = value;
            const output = byId(`qualityAdjustment-${key}-value`);
            if (output) output.textContent = value;
        }
        refresh();
    };
    if (!enabled.dataset.initialized) {
        enabled.dataset.initialized = 'true';
        enabled.addEventListener('change', refresh);
        byId('qualityAdjustmentReset')?.addEventListener('click', reset);
        for (const key of Object.keys(defaults)) {
            const input = byId(`qualityAdjustment-${key}`);
            input?.addEventListener('input', () => {
                const output = byId(`qualityAdjustment-${key}-value`);
                if (output) output.textContent = input.value;
            });
        }
    }
    reset();
}
