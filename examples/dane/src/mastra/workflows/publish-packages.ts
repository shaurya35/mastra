import { Step, Workflow } from '@mastra/core';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';

export const packagePublisher = new Workflow({
  name: 'pnpm-changset-publisher',
});

const getPacakgesToPublish = new Step({
  id: 'getPacakgesToPublish',
  outputSchema: z.object({
    packages: z.array(z.string()),
    integrations: z.array(z.string()),
    danePackage: z.string(),
  }),
  execute: async ({ mastra }) => {
    const agent = mastra?.agents?.['danePackagePublisher'];

    if (!agent) {
      throw new Error('Agent not found');
    }

    const result = await agent.generate(`
        Here is my project structure in my monorepo.
        * My core modules are in the 'packages' directory.
        * My integrations are in the 'integrations' directory.
        * My deployers are in the 'deployers' directory.

        Can you tell me which packages within these folders need to be published to npm?
    `);

    const resultObj = await agent.generate(
      `
      Can you format the following text with my described format?

      Formatting Rules:
      * If the text I am giving you says there are no publishable packages, return empty arrays.
      * @mastra/core must be first. 
      * @mastra/deployer must be second.
      * mastra must be third.
      
      Text: ${result.text}

      Very Important:
      * Do not include packages if we do not need to build them.
      * create-mastra is a package (not an integration) and should be listed in packages array.
      * @mastra/deployers-{name} should be listed after packages.
      * @mastra/dane should be listed after packages and integrations.    
    `,
      {
        output: z.object({
          packages: z.array(z.string()),
          integrations: z.array(z.string()),
          deployers: z.array(z.string()),
          danePackage: z.string(),
        }),
      },
    );

    console.log(resultObj.object);

    return {
      packages: resultObj?.object?.packages!,
      integrations: resultObj?.object?.integrations!,
      deployers: resultObj?.object?.deployers!,
      danePackage: resultObj?.object?.danePackage!,
    };
  },
});

const assemblePackages = new Step({
  id: 'assemblePackages',
  outputSchema: z.object({
    packages: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    if (context.machineContext?.stepResults.getPacakgesToPublish?.status !== 'success') {
      return {
        packages: [],
      };
    }

    const payload = context.machineContext.stepResults.getPacakgesToPublish.payload;
    const packagesToBuild: Set<string> = new Set();

    if (payload?.packages) {
      payload.packages.forEach((pkg: string) => {
        let pkgName = pkg.replace('@mastra/', '');

        if (pkgName === 'mastra') {
          pkgName = 'cli';
        }

        const pkgPath = path.join(process.cwd(), 'packages', pkgName);
        packagesToBuild.add(pkgPath);
      });
    }

    if (payload?.deployers) {
      payload.deployers.forEach((pkg: string) => {
        let pkgName = pkg.replace('@mastra/deployer-', '');

        if (pkgName === 'mastra') {
          pkgName = 'cli';
        }

        const pkgPath = path.join(process.cwd(), 'deployers', pkgName);
        packagesToBuild.add(pkgPath);
      });
    }

    if (payload?.integrations) {
      const integrations = payload.integrations;
      integrations.forEach((integration: string) => {
        let pkgName = integration.replace('@mastra/', '');
        const integrationPath = path.join(process.cwd(), 'integrations', pkgName);

        packagesToBuild.add(integrationPath);
      });
    }

    if (payload?.danePackage) {
      const danePackage = payload.danePackage;
      let pkgName = danePackage.replace('@mastra/', '');
      const danePackageMapped = path.join(process.cwd(), 'examples', pkgName);
      const pkgJsonPath = readFileSync(path.join(danePackageMapped, 'package.json'), 'utf-8');
      const pkgJson = JSON.parse(pkgJsonPath);
      const dependencies = Object.keys(pkgJson.dependencies || {}).filter((dep: string) => dep.startsWith('@mastra/'));
      dependencies.forEach((dep: string) => {
        const pkgName = dep.replace('@mastra/', '');
        const pkgPath = path.join(process.cwd(), 'packages', pkgName);
        const integrationPath = path.join(process.cwd(), 'integrations', pkgName);
        try {
          if (existsSync(pkgPath)) {
            packagesToBuild.add(pkgPath);
          } else {
            packagesToBuild.add(integrationPath);
          }
        } catch (e) {
          console.error(e);
        }
      });

      packagesToBuild.add(path.join(process.cwd(), 'examples', 'dane'));
    }

    const pkgSet = Array.from(packagesToBuild.keys());

    if (!packagesToBuild.size) {
      console.error(chalk.red('No packages to build.'));
      return {
        packages: [],
      };
    }

    return { packages: pkgSet };
  },
});

const buildPackages = new Step({
  id: 'buildPackages',
  outputSchema: z.object({
    packages: z.array(z.string()),
  }),
  execute: async ({ context, mastra }) => {
    if (context.machineContext?.stepResults.assemblePackages?.status !== 'success') {
      return {
        packages: [],
      };
    }

    const pkgSet = context.machineContext.stepResults.assemblePackages.payload.packages;

    const agent = mastra?.agents?.['danePackagePublisher'];

    if (!agent) {
      throw new Error('Agent not found');
    }

    console.log(chalk.green(`Building packages:`));

    pkgSet.forEach((pkg: string) => {
      console.log(chalk.green(pkg));
    });

    let res = await agent.generate(`
      Here are the packages that need to be built: ${pkgSet.join(',')}.

      ## Follow the rules:
      * @mastra/core must be first. 
      * @mastra/deployer must be second.
      * mastra must be third.

      Packages found within the 'packages' directory should be built next in parallel.
      Packages found within the 'integrations' directory should be built in parallel.
      Packages found within the 'deployers' directory should be built in parallel.

      Build @mastra/dane last.
      `);

    console.log(chalk.green(res.text));

    return { packages: pkgSet };
  },
});

const verifyBuild = new Step({
  id: 'verifyBuild',
  outputSchema: z.object({
    packages: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    if (context.machineContext?.stepResults.buildPackages?.status !== 'success') {
      return {
        packages: [],
      };
    }

    const pkgSet = context.machineContext.stepResults.buildPackages.payload.packages;

    for (const pkg of pkgSet) {
      if (!existsSync(`${pkg}/dist`)) {
        console.error(chalk.red(`Failed to build ${pkg}.`));
        throw new Error(`Failed to build ${pkg}.`);
      }
    }

    console.log(pkgSet);

    return {
      packages: pkgSet,
    };
  },
});

const publishChangeset = new Step({
  id: 'publishChangeset',
  outputSchema: z.object({
    packages: z.array(z.string()),
  }),
  execute: async ({ context, mastra }) => {
    if (context.machineContext?.stepResults.buildPackages?.status !== 'success') {
      return {
        packages: [],
      };
    }

    const pkgSet = context.machineContext.stepResults.buildPackages.payload.packages;

    const agent = mastra?.agents?.['danePackagePublisher'];

    if (!agent) {
      throw new Error('Agent not found');
    }
    let res = await agent.generate(`
            Publish the changeset.
        `);

    console.log(chalk.green(res.text));

    return { packages: pkgSet };
  },
});

const setLatestDistTag = new Step({
  id: 'setLatestDistTag',
  outputSchema: z.object({
    packages: z.array(z.string()),
  }),
  execute: async ({ context, mastra }) => {
    if (context.machineContext?.stepResults.publishChangeset?.status !== 'success') {
      return {
        packages: [],
      };
    }

    const pkgSet = context.machineContext.stepResults.publishChangeset.payload.packages;

    const agent = mastra?.agents?.['danePackagePublisher'];

    if (!agent) {
      throw new Error('Agent not found');
    }

    let res = await agent.generate(`
            Set the active tag for these packages ${pkgSet.join(',')}.
        `);

    console.log(chalk.green(res.text));

    return { packages: pkgSet };
  },
});

packagePublisher
  .step(getPacakgesToPublish)
  .then(assemblePackages)
  .then(buildPackages, {
    when: async ({ context }) => {
      return (
        context.stepResults.assemblePackages?.status === 'success' &&
        context.stepResults.assemblePackages?.payload?.packages.length > 0
      );
    },
  })
  .then(verifyBuild, {
    when: async ({ context }) => {
      return (
        context.stepResults.buildPackages?.status === 'success' &&
        context.stepResults.buildPackages?.payload?.packages.length > 0
      );
    },
  })
  .then(publishChangeset, {
    when: async ({ context }) => {
      return (
        context.stepResults.buildPackages?.status === 'success' &&
        context.stepResults.buildPackages?.payload?.packages.length > 0
      );
    },
  })
  .then(setLatestDistTag, {
    when: async ({ context }) => {
      return (
        context.stepResults.publishChangeset?.status === 'success' &&
        context.stepResults.publishChangeset?.payload?.packages.length > 0
      );
    },
  })
  .commit();
