import { describe, expect, it } from 'vitest';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';
import coreSchemas from '../../../plugins/browserclaw/core_schemas.json';

describe('core tool schema budget and contract', () => {
  it('keeps the registered core schemas under 20,000 JSON characters', () => {
    const chars = Object.values(coreSchemas).reduce(
      (total, schema) => total + JSON.stringify(schema).length,
      0,
    );
    expect(chars, 'core schema JSON character budget').toBeLessThan(20_000);
  });

  it('declares the new opt-in parameters in both the core plugin and shared schema', () => {
    const pluginNames = Object.keys(coreSchemas).sort();
    const shared = new Map(TOOL_SCHEMAS.map((tool: any) => [tool.name, tool]));
    expect(pluginNames).toHaveLength(18);
    for (const [name, property] of [
      ['chrome_read_dom', 'includeAssets'],
      ['chrome_get_markdown', 'mode'],
    ]) {
      expect((coreSchemas as any)[name].inputSchema.properties[property]).toEqual(
        (shared.get(name) as any).inputSchema.properties[property],
      );
    }
  });
});
