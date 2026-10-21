const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
    const ids = ['qualityAdjustmentEnabled', 'qualityAdjustmentFields', 'qualityAdjustmentReset'];
    for (const key of ['brightness', 'gamma', 'contrast', 'saturation', 'red', 'green', 'blue', 'denoise', 'sharpen']) {
        ids.push(`qualityAdjustment-${key}`, `qualityAdjustment-${key}-value`);
    }
    const nodes = Object.fromEntries(ids.map(id => [id, {
        dataset: {}, listeners: {}, addEventListener(event, fn) { this.listeners[event] = [...(this.listeners[event] || []), fn]; }
    }]));
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/features/qualityAdjustment.js'), 'utf8').replaceAll('export function ', 'function ');
    const context = vm.createContext({ document: { getElementById: id => nodes[id] } });
    vm.runInContext(source, context);
    return { nodes, context };
}

test('starts off, enables fields, updates labels, and resets without duplicate listeners', () => {
    const { nodes, context } = fixture();
    context.initQualityAdjustmentControls();
    expect(context.getQualityAdjustment().enabled).toBe(false);
    expect(context.getQualityAdjustment().gamma).toBe(1);
    expect(nodes.qualityAdjustmentFields.disabled).toBe(true);
    nodes.qualityAdjustmentEnabled.checked = true;
    nodes.qualityAdjustmentEnabled.listeners.change[0]();
    expect(nodes.qualityAdjustmentFields.disabled).toBe(false);
    nodes['qualityAdjustment-brightness'].value = '0.06';
    nodes['qualityAdjustment-brightness'].listeners.input[0]();
    expect(nodes['qualityAdjustment-brightness-value'].textContent).toBe('0.06');
    expect(context.getQualityAdjustment().brightness).toBe(0.06);
    nodes.qualityAdjustmentReset.listeners.click[0]();
    expect(context.getQualityAdjustment().enabled).toBe(false);
    expect(context.getQualityAdjustment().brightness).toBe(0);
    // A fresh modal session must independently clear prior non-neutral settings.
    nodes.qualityAdjustmentEnabled.checked = true;
    nodes.qualityAdjustmentEnabled.listeners.change[0]();
    nodes['qualityAdjustment-brightness'].value = '0.08';
    context.initQualityAdjustmentControls();
    expect(context.getQualityAdjustment().enabled).toBe(false);
    expect(context.getQualityAdjustment().brightness).toBe(0);
    expect(nodes.qualityAdjustmentFields.disabled).toBe(true);
    expect(nodes.qualityAdjustmentEnabled.listeners.change).toHaveLength(1);
    expect(nodes.qualityAdjustmentReset.listeners.click).toHaveLength(1);
});
