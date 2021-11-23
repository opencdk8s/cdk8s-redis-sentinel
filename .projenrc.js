const { ConstructLibraryCdk8s } = require('projen');
const project = new ConstructLibraryCdk8s({
  author: 'Hunter Thompson',
  authorAddress: 'aatman.bos@smallcase.com',
  defaultReleaseBranch: 'main',
  name: 'sc-infra-redis-sent',
  repositoryUrl: 'https://github.com/aatman.bos/sc-infra-redis-sent.git',

  cdk8sVersion: '1.0.0-beta.27',
  cdk8sPlusVersion: '1.0.0-beta.50',
  constructsVersion: '3.3.120',

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
  // release: undefined,      /* Add release management to this project. */
});
project.synth();