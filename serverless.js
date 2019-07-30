const aws = require('aws-sdk')
const path = require('path')
const util = require('util')
const types = require('./serverless.types.js')
const exec = util.promisify(require('child_process').exec)
const { Component, utils } = require('@serverless/core')
const {
  configureBucketForHosting,
  configureDomainForBucket,
  configureBucketForRedirect
} = require('./utils')

/*
 * Website
 */

class Website extends Component {
  /**
   * Types
   */

  types() {
    return types
  }

  /*
   * Default
   */

  async default(inputs = {}) {
    this.context.status('Deploying')

    // Default to current working directory
    inputs.code = inputs.code || {}
    inputs.code.root = inputs.code.root ? path.resolve(inputs.code.root) : process.cwd()
    if (inputs.code.src) {
      inputs.code.src = path.join(inputs.code.root, inputs.code.src)
    }
    inputs.region = inputs.region || 'us-east-1'
    inputs.bucketName = this.state.bucketName || inputs.domain || this.context.resourceId()

    this.context.status(`Preparing AWS S3 Bucket`)
    this.context.debug(`Deploying website bucket in ${inputs.region}.`)

    const websiteBucket = await this.load('@serverless/aws-s3', 'websiteBucket')
    const bucketOutputs = await websiteBucket({
      name: inputs.bucketName,
      accelerated: false,
      region: inputs.region
    })

    const s3 = new aws.S3({ region: inputs.region, credentials: this.context.credentials.aws })

    this.context.debug(`Configuring bucket ${inputs.bucketName} for website hosting.`)
    await configureBucketForHosting(s3, inputs.bucketName)

    if (inputs.domain) {
      const route53 = new aws.Route53({
        region: inputs.region,
        credentials: this.context.credentials.aws
      })

      this.context.debug(`Domain specified. Deploying redirect bucket www.${inputs.domain}.`)
      const redirectBucket = await this.load('@serverless/aws-s3', 'redirectBucket')
      await redirectBucket({
        name: `www.${inputs.domain}`,
        accelerated: false,
        region: inputs.region
      })

      await configureBucketForRedirect(s3, `www.${inputs.domain}`, inputs.domain)

      this.context.debug(`Setting domain ${inputs.domain} for bucket.`)
      await configureDomainForBucket(route53, inputs.domain, inputs.region)
      await configureDomainForBucket(route53, `www.${inputs.domain}`, inputs.region)
    }

    if (this.state.domain && this.state.domain !== inputs.domain) {
      const route53 = new aws.Route53({
        region: inputs.region,
        credentials: this.context.credentials.aws
      })
      await configureDomainForBucket(route53, this.state.domain, this.state.region, 'DELETE')
      await configureDomainForBucket(
        route53,
        `www.${this.state.domain}`,
        this.state.region,
        'DELETE'
      )
    }

    // Build environment variables
    if (inputs.env && Object.keys(inputs.env).length && inputs.code.root) {
      this.context.status(`Bundling environment variables`)
      this.context.debug(`Bundling website environment variables.`)
      let script = 'window.env = {};\n'
      inputs.env = inputs.env || {}
      for (const e in inputs.env) {
        // eslint-disable-line
        script += `window.env.${e} = ${JSON.stringify(inputs.env[e])};\n` // eslint-disable-line
      }
      const envFilePath = path.join(inputs.code.root, 'env.js')
      await utils.writeFile(envFilePath, script)
      this.context.debug(`Website env written to file ${envFilePath}.`)
    }

    // If a hook is provided, build the website
    if (inputs.code.hook) {
      this.context.status('Building assets')
      this.context.debug(`Running ${inputs.code.hook} in ${inputs.code.root}.`)

      const options = { cwd: inputs.code.root }
      try {
        await exec(inputs.code.hook, options)
      } catch (err) {
        console.error(err.stderr) // eslint-disable-line
        throw new Error(
          `Failed building website via "${inputs.code.hook}" due to the following error: "${err.stderr}"`
        )
      }
    }

    this.context.status('Uploading')

    const dirToUploadPath = inputs.code.src || inputs.code.root

    this.context.debug(
      `Uploading website files from ${dirToUploadPath} to bucket ${bucketOutputs.name}.`
    )

    await websiteBucket.upload({ dir: dirToUploadPath })

    this.state.bucketName = inputs.bucketName
    this.state.domain = inputs.domain
    this.state.region = inputs.region
    this.state.url = `http://${bucketOutputs.name}.s3-website-${inputs.region}.amazonaws.com`
    await this.save()

    this.context.debug(`Website deployed successfully to URL: ${this.state.url}.`)
    this.context.output('url', this.state.url)

    const outputs = {
      url: this.state.url,
      env: inputs.env || {}
    }

    if (inputs.domain) {
      outputs.domain = `http://${inputs.domain}`
    }

    return outputs
  }

  /**
   * Remove
   */

  async remove() {
    this.context.status(`Removing`)

    this.context.debug(`removing website bucket.`)
    const websiteBucket = await this.load('@serverless/aws-s3', 'websiteBucket')
    await websiteBucket.remove()

    if (this.state.domain) {
      this.context.debug(`Domain was specified. Removing domain ${this.state.domain}.`)
      const route53 = new aws.Route53({
        region: this.state.region,
        credentials: this.context.credentials.aws
      })
      await configureDomainForBucket(route53, this.state.domain, this.state.region, 'DELETE')
      await configureDomainForBucket(
        route53,
        `www.${this.state.domain}`,
        this.state.region,
        'DELETE'
      )

      this.context.debug(`Removing redirect bucket.`)
      const redirectBucket = await this.load('@serverless/aws-s3', 'redirectBucket')
      await redirectBucket.remove()
    }

    this.state = {}
    await this.save()
    return {}
  }
}

module.exports = Website
