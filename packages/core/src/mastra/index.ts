import { z } from 'zod';

import 'dotenv/config';

import { Agent } from '../agent';
import { MastraDeployer } from '../deployer';
import { MastraEngine } from '../engine';
import { LLM } from '../llm';
import { ModelConfig } from '../llm/types';
import { LogLevel, Logger, createLogger, noopLogger } from '../logger';
import { MastraMemory } from '../memory';
import { Run } from '../run/types';
import { SyncAction } from '../sync';
import { InstrumentClass, OtelConfig, Telemetry } from '../telemetry';
import { MastraTTS } from '../tts';
import { MastraVector } from '../vector';
import { Workflow } from '../workflows';

import { StripUndefined } from './types';

@InstrumentClass({
  prefix: 'mastra',
  excludeMethods: ['getLogger', 'getTelemetry'],
})
export class Mastra<
  TSyncs extends Record<string, SyncAction<any, any, any, any>> = Record<string, SyncAction<any, any, any, any>>,
  TAgents extends Record<string, Agent<any>> = Record<string, Agent<any>>,
  TWorkflows extends Record<string, Workflow> = Record<string, Workflow>,
  TVectors extends Record<string, MastraVector> = Record<string, MastraVector>,
  TTTS extends Record<string, MastraTTS> = Record<string, MastraTTS>,
  TLogger extends Logger = Logger,
> {
  private vectors?: TVectors;
  private agents: TAgents;
  private logger: TLogger;
  private syncs: TSyncs;
  private workflows: TWorkflows;
  private telemetry?: Telemetry;
  private tts?: TTTS;
  private deployer?: MastraDeployer;
  engine?: MastraEngine;
  memory?: MastraMemory;

  constructor(config?: {
    memory?: MastraMemory;
    syncs?: TSyncs;
    agents?: TAgents;
    engine?: MastraEngine;
    vectors?: TVectors;
    logger?: TLogger | false;
    workflows?: TWorkflows;
    tts?: TTTS;
    telemetry?: OtelConfig;
    deployer?: MastraDeployer;
  }) {
    /*
      Logger
    */

    if (config?.logger === false) {
      this.logger = noopLogger as unknown as TLogger;
    } else {
      if (config?.logger) {
        this.logger = config.logger;
      } else {
        const levleOnEnv = process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO;
        this.logger = createLogger({ name: 'Mastra', level: levleOnEnv }) as unknown as TLogger;
      }
    }

    /*
    Telemetry
    */
    if (config?.telemetry) {
      this.telemetry = Telemetry.init(config.telemetry);
    }

    /**
     * Deployer
     **/
    if (config?.deployer) {
      this.deployer = config.deployer;
      if (this.telemetry) {
        this.deployer = this.telemetry.traceClass(config.deployer, {
          excludeMethods: ['__setTelemetry', '__getTelemetry'],
        });
        this.deployer.__setTelemetry(this.telemetry);
      }
      this.deployer.__setLogger(this.logger);
    }

    /*
   Engine
   */
    if (config?.engine) {
      if (this.telemetry) {
        this.engine = this.telemetry.traceClass(config.engine, {
          excludeMethods: ['__setTelemetry', '__getTelemetry'],
        });
        this.engine.__setTelemetry(this.telemetry);
      } else {
        this.engine = config.engine;
      }
      this.engine.__setLogger(this.logger);
    }

    /*
    Vectors
    */
    if (config?.vectors) {
      let vectors: Record<string, MastraVector> = {};
      Object.entries(config.vectors).forEach(([key, vector]) => {
        if (this.telemetry) {
          vectors[key] = this.telemetry.traceClass(vector, {
            excludeMethods: ['__setTelemetry', '__getTelemetry'],
          });
          vectors[key].__setTelemetry(this.telemetry);
        } else {
          vectors[key] = vector;
        }

        vectors[key].__setLogger(this.logger);
      });

      this.vectors = vectors as TVectors;
    }

    /*
    Syncs
    */
    if (config?.syncs && !config.engine) {
      throw new Error('Engine is required to run syncs');
    }

    this.syncs = (config?.syncs || {}) as TSyncs;

    if (config?.syncs && !config?.engine) {
      throw new Error('Engine is required to run syncs');
    }

    this.syncs = (config?.syncs || {}) as TSyncs;

    if (config?.engine) {
      this.engine = config.engine;
    }

    if (config?.vectors) {
      this.vectors = config.vectors;
    }

    if (config?.memory) {
      this.memory = config.memory;
      if (this.telemetry) {
        this.memory = this.telemetry.traceClass(config.memory, {
          excludeMethods: ['__setTelemetry', '__getTelemetry'],
        });
        this.memory.__setTelemetry(this.telemetry);
      }

      if (this.memory) {
        this.memory.__setLogger(this.logger);
      }
    }

    if (config?.tts) {
      this.tts = config.tts;
      Object.entries(this.tts).forEach(([key, ttsCl]) => {
        if (this.tts?.[key]) {
          if (this.telemetry) {
            // @ts-ignore
            this.tts[key] = this.telemetry.traceClass(ttsCl, {
              excludeMethods: ['__setTelemetry', '__getTelemetry'],
            });
            this.tts[key].__setTelemetry(this.telemetry);
          }
          this.tts[key].__setLogger(this.logger);
        }
      });
    }

    /*
    Agents
    */
    const agents: Record<string, Agent> = {};
    if (config?.agents) {
      Object.entries(config.agents).forEach(([key, agent]) => {
        if (agents[key]) {
          throw new Error(`Agent with name ID:${key} already exists`);
        }

        agent.__registerPrimitives({
          logger: this.getLogger(),
          telemetry: this.telemetry,
          engine: this.engine,
          memory: this.memory,
          syncs: this.syncs,
          agents: agents,
          tts: this.tts,
          vectors: this.vectors,
        });

        agents[key] = agent;
      });
    }

    this.agents = agents as TAgents;

    /*
    Workflows
    */
    this.workflows = {} as TWorkflows;

    if (config?.workflows) {
      Object.entries(config.workflows).forEach(([key, workflow]) => {
        workflow.__registerPrimitives({
          logger: this.getLogger(),
          telemetry: this.telemetry,
          engine: this.engine,
          memory: this.memory,
          syncs: this.syncs,
          agents: this.agents,
          tts: this.tts,
          vectors: this.vectors,
          llm: this.LLM,
        });

        // @ts-ignore
        this.workflows[key] = workflow;
      });
    }
  }

  LLM(modelConfig: ModelConfig) {
    const llm = new LLM({
      model: modelConfig,
    });

    if (this.telemetry) {
      llm.__setTelemetry(this.telemetry);
    }

    if (this.getLogger) {
      llm.__setLogger(this.getLogger());
    }

    return llm;
  }

  public async sync<K extends keyof TSyncs>(
    key: K,
    params: TSyncs[K] extends SyncAction<any, infer TSchemaIn, any, any>
      ? TSchemaIn extends z.ZodSchema
        ? z.infer<TSchemaIn>
        : never
      : never,
    runId?: Run['runId'],
  ): Promise<StripUndefined<TSyncs[K]['outputSchema']>['_input']> {
    if (!this.engine) {
      throw new Error(`Engine is required to run syncs`);
    }

    const sync = this.syncs?.[key];
    if (!sync) {
      throw new Error(`Sync function ${key as string} not found`);
    }

    const syncFn = sync['execute'];
    if (!syncFn) {
      throw new Error(`Sync function ${key as string} not found`);
    }

    return await syncFn({
      context: params,
      mastra: {
        engine: this.engine,
        memory: this.memory,
        agents: this.agents,
        vectors: this.vectors,
        llm: this.LLM,
        tts: this.tts,
      },
      runId,
    });
  }

  public getAgent<TAgentName extends keyof TAgents>(name: TAgentName): TAgents[TAgentName] {
    const agent = this.agents?.[name];
    if (!agent) {
      throw new Error(`Agent with name ${String(name)} not found`);
    }
    return this.agents[name];
  }

  public getAgents() {
    return this.agents;
  }

  public getVector<TVectorName extends keyof TVectors>(name: TVectorName): TVectors[TVectorName] {
    const vector = this.vectors?.[name];
    if (!vector) {
      throw new Error(`Vector with name ${String(name)} not found`);
    }
    return vector;
  }

  public getVectors() {
    return this.vectors;
  }

  public getDeployer() {
    return this.deployer;
  }

  public getWorkflow<TWorkflowId extends keyof TWorkflows>(
    id: TWorkflowId,
    { serialized }: { serialized?: boolean } = {},
  ): TWorkflows[TWorkflowId] {
    const workflow = this.workflows?.[id];
    if (!workflow) {
      throw new Error(`Workflow with ID ${String(id)} not found`);
    }

    if (serialized) {
      return { name: workflow.name } as TWorkflows[TWorkflowId];
    }

    return workflow;
  }

  public getWorkflows(props: { serialized?: boolean } = {}): Record<string, Workflow> {
    if (props.serialized) {
      return Object.entries(this.workflows).reduce((acc, [k, v]) => {
        return {
          ...acc,
          [k]: { name: v.name },
        };
      }, {});
    }
    return this.workflows;
  }

  public setLogger({ logger }: { logger: TLogger }) {
    this.logger = logger;
  }

  public getLogger() {
    return this.logger;
  }

  public getTelemetry() {
    return this.telemetry;
  }

  public async getLogsByRunId({ runId, transportId }: { runId: string; transportId: string }) {
    if (!transportId) {
      throw new Error('Transport ID is required');
    }
    return await this.logger.getLogsByRunId({ runId, transportId });
  }

  public async getLogs(transportId: string) {
    if (!transportId) {
      throw new Error('Transport ID is required');
    }
    return await this.logger.getLogs(transportId);
  }
}
