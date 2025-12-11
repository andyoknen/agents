#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");

// Agent models mapping
const AGENT_MODELS: Record<string, string> = {
  analyst: "opus-4.5",
  architect: "opus-4.5",
  planner: "opus-4.5",
  tz_reviewer: "composer-1",
  architecture_reviewer: "composer-1",
  plan_reviewer: "composer-1",
  developer: "composer-1",
  code_reviewer: "composer-1",
};

// Agent prompt files mapping
const AGENT_PROMPTS: Record<string, string> = {
  analyst: "agents/02_analyst_prompt.md",
  tz_reviewer: "agents/03_tz_reviewer_prompt.md",
  architect: "agents/04_architect_prompt.md",
  architecture_reviewer: "agents/05_architecture_reviewer_prompt.md",
  planner: "agents/06_agent_planner.md",
  plan_reviewer: "agents/07_agent_plan_reviewer.md",
  developer: "agents/08_agent_developer.md",
  code_reviewer: "agents/09_agent_code_reviewer.md",
};

class AgentMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "autodialer-agents-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "call_analyst",
            description:
              "Call analyst agent to create technical specification (TZ)",
            inputSchema: {
              type: "object",
              properties: {
                task_description: {
                  type: "string",
                  description: "High-level task description from user",
                },
                project_description: {
                  type: "string",
                  description: "Existing project description (if applicable)",
                },
              },
              required: ["task_description"],
            },
          },
          {
            name: "call_tz_reviewer",
            description: "Review technical specification created by analyst",
            inputSchema: {
              type: "object",
              properties: {
                tz_file: {
                  type: "string",
                  description: "Path to TZ file (from tmp/)",
                },
                task_description: {
                  type: "string",
                  description: "Original task description",
                },
                project_description: {
                  type: "string",
                  description: "Project description",
                },
              },
              required: ["tz_file", "task_description"],
            },
          },
          {
            name: "call_architect",
            description: "Call architect agent to design system architecture",
            inputSchema: {
              type: "object",
              properties: {
                tz_file: {
                  type: "string",
                  description: "Path to approved TZ file (from tmp/)",
                },
                project_description: {
                  type: "string",
                  description: "Project description",
                },
              },
              required: ["tz_file"],
            },
          },
          {
            name: "call_architecture_reviewer",
            description: "Review architecture design",
            inputSchema: {
              type: "object",
              properties: {
                architecture_file: {
                  type: "string",
                  description: "Path to architecture file (from tmp/)",
                },
                tz_file: {
                  type: "string",
                  description: "Path to TZ file",
                },
                project_description: {
                  type: "string",
                  description: "Project description",
                },
              },
              required: ["architecture_file", "tz_file"],
            },
          },
          {
            name: "call_planner",
            description: "Call planner agent to create development plan",
            inputSchema: {
              type: "object",
              properties: {
                tz_file: {
                  type: "string",
                  description: "Path to TZ file (from tmp/)",
                },
                architecture_file: {
                  type: "string",
                  description: "Path to architecture file (from tmp/)",
                },
                project_description: {
                  type: "string",
                  description: "Project description",
                },
              },
              required: ["tz_file", "architecture_file"],
            },
          },
          {
            name: "call_plan_reviewer",
            description: "Review development plan",
            inputSchema: {
              type: "object",
              properties: {
                plan_file: {
                  type: "string",
                  description: "Path to plan file (from tmp/)",
                },
                task_files: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of task file paths (from tmp/tasks/)",
                },
                tz_file: {
                  type: "string",
                  description: "Path to TZ file",
                },
              },
              required: ["plan_file", "task_files", "tz_file"],
            },
          },
          {
            name: "call_developer",
            description: "Call developer agent to implement task",
            inputSchema: {
              type: "object",
              properties: {
                task_file: {
                  type: "string",
                  description: "Path to task description file (from tmp/tasks/)",
                },
                project_code: {
                  type: "string",
                  description: "Current project code context",
                },
                project_docs: {
                  type: "string",
                  description: "Project documentation",
                },
              },
              required: ["task_file"],
            },
          },
          {
            name: "call_code_reviewer",
            description: "Review code implementation",
            inputSchema: {
              type: "object",
              properties: {
                task_file: {
                  type: "string",
                  description: "Path to task description file (from tmp/tasks/)",
                },
                modified_files: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of modified file paths",
                },
                test_report: {
                  type: "string",
                  description: "Path to test report (from tmp/)",
                },
                project_code: {
                  type: "string",
                  description: "Current project code",
                },
              },
              required: ["task_file", "test_report"],
            },
          },
        ] as Tool[],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!args) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Missing arguments for tool call",
            },
          ],
          isError: true,
        };
      }

      try {
        switch (name) {
          case "call_analyst":
            return await this.callAgent("analyst", {
              task_description: args.task_description as string,
              project_description: (args.project_description as string) || "",
            });

          case "call_tz_reviewer":
            return await this.callAgent("tz_reviewer", {
              tz_file: args.tz_file as string,
              task_description: args.task_description as string,
              project_description: (args.project_description as string) || "",
            });

          case "call_architect":
            return await this.callAgent("architect", {
              tz_file: args.tz_file as string,
              project_description: (args.project_description as string) || "",
            });

          case "call_architecture_reviewer":
            return await this.callAgent("architecture_reviewer", {
              architecture_file: args.architecture_file as string,
              tz_file: args.tz_file as string,
              project_description: (args.project_description as string) || "",
            });

          case "call_planner":
            return await this.callAgent("planner", {
              tz_file: args.tz_file as string,
              architecture_file: args.architecture_file as string,
              project_description: (args.project_description as string) || "",
            });

          case "call_plan_reviewer":
            return await this.callAgent("plan_reviewer", {
              plan_file: args.plan_file as string,
              task_files: args.task_files as string[],
              tz_file: args.tz_file as string,
            });

          case "call_developer":
            return await this.callAgent("developer", {
              task_file: args.task_file as string,
              project_code: (args.project_code as string) || "",
              project_docs: (args.project_docs as string) || "",
            });

          case "call_code_reviewer":
            return await this.callAgent("code_reviewer", {
              task_file: args.task_file as string,
              modified_files: (args.modified_files as string[]) || [],
              test_report: args.test_report as string,
              project_code: (args.project_code as string) || "",
            });

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async callAgent(
    agentType: string,
    inputs: Record<string, any>
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const promptFile = AGENT_PROMPTS[agentType];
    if (!promptFile) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    const model = AGENT_MODELS[agentType];
    const promptPath = join(PROJECT_ROOT, promptFile);

    // Read agent prompt
    const agentPrompt = await readFile(promptPath, "utf-8");

    // Build full prompt with inputs
    let fullPrompt = agentPrompt;
    fullPrompt += "\n\n## ВХОДНЫЕ ДАННЫЕ:\n\n";
    for (const [key, value] of Object.entries(inputs)) {
      if (value) {
        if (Array.isArray(value)) {
          fullPrompt += `- ${key}: ${value.join(", ")}\n`;
        } else {
          fullPrompt += `- ${key}: ${value}\n`;
        }
      }
    }

    // Execute cursor-agent command
    const command = `cursor-agent -f --model ${model} -p ${JSON.stringify(
      fullPrompt
    )}`;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: PROJECT_ROOT,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      if (stderr && !stdout) {
        return {
          content: [
            {
              type: "text",
              text: `Agent execution error:\n${stderr}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: stdout || "Agent completed successfully (no output)",
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to execute agent: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Autodialer Agents MCP server running on stdio");
  }
}

// Start server
const server = new AgentMCPServer();
server.run().catch(console.error);
