import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

interface SkillDef {
  name: string;
  description: string;
  instructions: string;
}

/**
 * Skills Plugin — Progressive Disclosure パターン
 *
 * 起動時: スキルの名前と説明だけ System Prompt に注入（軽量）
 * 実行時: LLM が activate_skill ツールを呼び、フル指示を取得
 */
export class SkillsPlugin {
  private skills: Map<string, SkillDef> = new Map();

  get name() {
    return 'skills-plugin';
  }

  constructor(skillsDir: string) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = join(skillsDir, entry.name, 'SKILL.md');
      try {
        const content = readFileSync(mdPath, 'utf-8');
        const skill = this.parseSkillMd(content);
        this.skills.set(skill.name, skill);
      } catch {
        // SKILL.md がないディレクトリはスキップ
      }
    }
  }

  initAgent(agent: any): void {
    if (this.skills.size === 0) return;

    const skillList = [...this.skills.values()]
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join('\n');

    agent.systemPrompt += `

<available_skills>
以下のスキルが利用可能です。ユーザーの指示に応じて activate_skill ツールでフル指示を読み込み、それに MUST 従って出力すること。
スキルの使用を明示的に指示されていない場合は、activate_skill を MUST NOT 呼ばないこと。

${skillList}
</available_skills>`;
  }

  getTools() {
    return [
      tool({
        name: 'activate_skill',
        description:
          '指定されたスキルのフル指示を読み込む。ユーザーが明示的にスキル名やテンプレートの使用を指示した場合、または詳細レポートの生成を依頼された場合にのみ呼び出す。概要回答や対話的な応答では呼び出さない。',
        inputSchema: z.object({
          skillName: z.string().describe('スキル名 (例: analysis-template)'),
        }),
        callback: ({ skillName }) => {
          const skill = this.skills.get(skillName);
          if (!skill) {
            const available = [...this.skills.keys()].join(', ');
            return `スキル '${skillName}' が見つかりません。利用可能なスキル: ${available}`;
          }
          return skill.instructions;
        },
      }),
    ];
  }

  private parseSkillMd(content: string): SkillDef {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error('Invalid SKILL.md format');

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      meta[key] = value;
    }

    if (!meta.name || !meta.description) {
      throw new Error('SKILL.md must have name and description in frontmatter');
    }

    return {
      name: meta.name,
      description: meta.description,
      instructions: match[2].trim(),
    };
  }
}
