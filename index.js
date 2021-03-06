const core = require('@actions/core');
const util = require('util');
const path = require('path');
const axios = require('axios').default;
const crypto = require('crypto');

const readFile = util.promisify(require('fs').readFile);
const glob = util.promisify(require('glob'));


class HasuraAllowlistClient {
  constructor(host, adminKey) {
    this.host = host;
    this.adminKey = adminKey;
  }

  get authData() {
    return {
      headers: {
        'X-Hasura-Role': 'admin',
        'X-Hasura-Admin-Secret': this.adminKey,
      },
    };
  }

  async createQueryCollection(name) {
    const payload = {
      "type" : "create_query_collection",
      "args": {
          "name": name,
          "comment": "",
          "definition": {
              "queries": [],
          }
      }
    };
    return axios.post(`${this.host}/v1/query`, payload, this.authData);
  }

  async addQueryToCollection(name, queryName, query) {
    const payload = {
      "type" : "add_query_to_collection",
      "args": {
          "collection_name": name,
          "query_name": queryName,
          "query": query,
      }
    };
    return axios.post(`${this.host}/v1/query`, payload, this.authData);
  }

  async addCollectionToAllowlist(name) {
    const payload = {
      "type" : "add_collection_to_allowlist",
      "args": {
          "collection": name,
      }
    };
    return axios.post(`${this.host}/v1/query`, payload, this.authData);
  }
}

/** @returns {Array<{ name: string, query: string }>} */
async function getGQLFiles(filesPath = '**/*.gql', appendMetadata = false) {

  const files = await glob(filesPath);
  const filesReader = files.map(async file => {

    const content = await readFile(file, 'utf8');
    const fileContentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    return {
      name: `${path.basename(file)}${appendMetadata ? `_${process.env.GITHUB_REPOSITORY}_${fileContentHash}` : ''}`,
      query: content,
    };

  });

  return Promise.all(filesReader);
}


/**
 * Hasura does not provide API to check whether query collection with name 'allowed-queries' present
 * so we have to call API first then check ignorable(expected) error
 * @param {Boolean} ignoreAlreadyExistsError
 * @param {Boolean} ignoreDatabaseError
 */
function handleHasuraError(ignoreAlreadyExistsError = false, ignoreDatabaseError = false) {
  return function (error) {

    if (error.response) {

      if (ignoreAlreadyExistsError === true) {
        if (error.response.data && error.response.status === 400) {
          if (error.response.data.code === 'already-exists') {
            // error to ignore (createQueryCollection)
            console.log('Ignored createQueryCollection/addQueryToCollection error, because collection name to add already exists.');
            return true;
          }
        }
      }
      if (ignoreDatabaseError === true) {
        if (error.response.data && error.response.status === 500) {
          if (error.response.data.error === 'database query error') {
            // error to ignore (addCollectionToAllowlist)
            console.log('Ignored addCollectionToAllowlist error, because collection name to add already exists.');
            return;
          }
        }
      }

    }
    throw error;
  }
}


async function run() {
  try {
    if (!process.env.GITHUB_WORKSPACE) {
      throw new Error('process.env.GITHUB_WORKSPACE is null');
    }

    const HASURA_URL = core.getInput('host');
    const HASURA_KEY = core.getInput('key');
    const targetPath = core.getInput('path');
    const client = new HasuraAllowlistClient(HASURA_URL, HASURA_KEY);

    const gqls = await getGQLFiles(targetPath || `${process.env.GITHUB_WORKSPACE}/**/*.gql`, true);

    // const collectionName = `QueryCollection_${DateTime.local().setZone('Asia/Seoul').toFormat('yyyyMMdd')}`;
    // https://github.com/hasura/graphql-engine/issues/4138
    const collectionName = 'allowed-queries';
    // can fail
    const collectionNameDidAlreadyExist = await client.createQueryCollection(collectionName).then(() => false).catch(handleHasuraError(true, false));

    for (const { name, query } of gqls) {
      await client.addQueryToCollection(collectionName, name, query).catch(handleHasuraError(true, false));
    }
    await client.addCollectionToAllowlist(collectionName).catch(handleHasuraError(true, collectionNameDidAlreadyExist === true));

  }
  catch (error) {
    console.error(error)
    core.setFailed(error.message);
  }
}

run();
