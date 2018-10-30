/* @flow */

import bitcoin from 'bitcoinjs-lib'
import crypto from 'crypto'
import { decodeToken, TokenSigner, TokenVerifier } from 'jsontokens'
import { ecPairToHexString } from 'blockstack'
import { ValidationError } from './errors'
import logger from 'winston'

const DEFAULT_STORAGE_URL = 'storage.blockstack.org'
export const LATEST_AUTH_VERSION = 'v1'

function pubkeyHexToECPair (pubkeyHex) {
  const pkBuff = Buffer.from(pubkeyHex, 'hex')
  return bitcoin.ECPair.fromPublicKeyBuffer(pkBuff)
}

export class V1Authentication {
  token: string

  constructor(token: string) {
    this.token = token
  }

  static fromAuthPart(authPart: string) {
    if (!authPart.startsWith('v1:')) {
      throw new ValidationError('Authorization header should start with v1:')
    }
    const token = authPart.slice('v1:'.length)
    let decodedToken
    try {
      decodedToken = decodeToken(token)
    } catch (e) {
      logger.error(e)
      logger.error('fromAuthPart')
      throw new ValidationError('Failed to decode authentication JWT')
    }
    const publicKey = decodedToken.payload.iss
    if (!publicKey || !decodedToken) {
      throw new ValidationError('Auth token should be a JWT with at least an `iss` claim')
    }
    return new V1Authentication(token)
  }

  static makeAuthPart(secretKey: bitcoin.ECPair, challengeText: string,
                      associationToken?: string, hubUrl?: string) {

    const FOUR_MONTH_SECONDS = 60 * 60 * 24 * 31 * 4
    const publicKeyHex = secretKey.getPublicKeyBuffer().toString('hex')
    const salt = crypto.randomBytes(16).toString('hex')
    const payload = { gaiaChallenge: challengeText,
                      iss: publicKeyHex,
                      exp: FOUR_MONTH_SECONDS + (new Date()/1000),
                      associationToken,
                      hubUrl, salt }
    const signerKeyHex = ecPairToHexString(secretKey).slice(0, 64)
    const token = new TokenSigner('ES256K', signerKeyHex).sign(payload)
    return `v1:${token}`
  }

  static makeAssociationToken(secretKey: bitcoin.ECPair, childPublicKey: string) {
    const FOUR_MONTH_SECONDS = 60 * 60 * 24 * 31 * 4
    const publicKeyHex = secretKey.getPublicKeyBuffer().toString('hex')
    const salt = crypto.randomBytes(16).toString('hex')
    const payload = { childToAssociate: childPublicKey,
                      iss: publicKeyHex,
                      exp: FOUR_MONTH_SECONDS + (new Date()/1000),
                      salt }
    const signerKeyHex = ecPairToHexString(secretKey).slice(0, 64)
    const token = new TokenSigner('ES256K', signerKeyHex).sign(payload)
    return token
  }

  checkAssociationToken(token: string, bearerAddress: string) {
    // a JWT can have an `associationToken` that was signed by one of the
    // whitelisted addresses on this server.  This method checks a given
    // associationToken and verifies that it authorizes the "outer"
    // JWT's address (`bearerAddress`)

    let associationToken
    try {
      associationToken = decodeToken(token)
    } catch (e) {
      throw new ValidationError('Failed to decode association token in JWT')
    }

    // publicKey (the issuer of the association token)
    // will be the whitelisted address (i.e. the identity address)
    const publicKey = associationToken.payload.iss
    const childPublicKey = associationToken.payload.childToAssociate
    const expiresAt = associationToken.payload.exp

    if (! publicKey) {
      throw new ValidationError('Must provide `iss` claim in association JWT.')
    }

    if (! childPublicKey) {
      throw new ValidationError('Must provide `childToAssociate` claim in association JWT.')
    }

    if (! expiresAt) {
      throw new ValidationError('Must provide `exp` claim in association JWT.')
    }

    const verified = new TokenVerifier('ES256K', publicKey).verify(token)
    if (!verified) {
      throw new ValidationError('Failed to verify association JWT: invalid issuer')
    }

    if (expiresAt < (new Date()/1000)) {
      throw new ValidationError(
        `Expired association token: expire time of ${expiresAt} (secs since epoch)`)
    }

    // the bearer of the association token must have authorized the bearer
    const childAddress = pubkeyHexToECPair(childPublicKey).getAddress()
    if (childAddress !== bearerAddress) {
      throw new ValidationError(
        `Association token child key ${childPublicKey} does not match ${bearerAddress}`)
    }

    const signerAddress = pubkeyHexToECPair(publicKey).getAddress()
    return signerAddress

  }

  /*
   * Determine if the authentication token is valid:
   * * must have signed the given `challengeText`
   * * must not be expired
   * * if it contains an associationToken, then the associationToken must
   *   authorize the given address.
   *
   * Returns the address that signed off on this token, which will be
   * checked against the server's whitelist.
   * * If this token has an associationToken, then the signing address
   *   is the address that signed the associationToken.
   * * Otherwise, the signing address is the given address.
   *
   * this throws a ValidationError if the authentication is invalid
   */
  isAuthenticationValid(address: string, challengeText: string,
                        options?: { requireCorrectHubUrl?: boolean,
                                    validHubUrls?: Array<string> }) : string {
    let decodedToken
    try {
      decodedToken = decodeToken(this.token)
    } catch (e) {
      logger.error(this.token)
      logger.error('isAuthenticationValid')
      throw new ValidationError('Failed to decode authentication JWT')
    }

    const publicKey = decodedToken.payload.iss
    const gaiaChallenge = decodedToken.payload.gaiaChallenge

    if (! publicKey) {
      throw new ValidationError('Must provide `iss` claim in JWT.')
    }

    const issuerAddress = pubkeyHexToECPair(publicKey).getAddress()

    if (issuerAddress !== address) {
      throw new ValidationError('Address not allowed to write on this path')
    }

    if (options && options.requireCorrectHubUrl) {
      let claimedHub = decodedToken.payload.hubUrl
      if (!claimedHub) {
        throw new ValidationError(
          'Authentication must provide a claimed hub. You may need to update blockstack.js.')
      }
      if (claimedHub.endsWith('/')) {
        claimedHub = claimedHub.slice(0, -1)
      }
      const validHubUrls = options.validHubUrls
      if (!validHubUrls) {
        throw new ValidationError(
          'Configuration error on the gaia hub. validHubUrls must be supplied.')
      }
      if (validHubUrls.indexOf(claimedHub) < 0) {
        throw new ValidationError(
          `Auth token's claimed hub url '${claimedHub}' not found` +
            ` in this hubs set: ${JSON.stringify(validHubUrls)}`)
      }
    }

    const verified = new TokenVerifier('ES256K', publicKey).verify(this.token)
    if (!verified) {
      throw new ValidationError('Failed to verify supplied authentication JWT')
    }

    if (gaiaChallenge !== challengeText) {
      throw new ValidationError(`Invalid gaiaChallenge text in supplied JWT: ${gaiaChallenge}`)
    }

    const expiresAt = decodedToken.payload.exp
    if (expiresAt && expiresAt < (new Date()/1000)) {
      throw new ValidationError(
        `Expired authentication token: expire time of ${expiresAt} (secs since epoch)`)
    }

    if (decodedToken.payload.hasOwnProperty('associationToken') &&
        decodedToken.payload.associationToken) {
      return this.checkAssociationToken(
        decodedToken.payload.associationToken, address)
    } else {
      return address
    }
  }
}

export class LegacyAuthentication {
  publickey: bitcoin.ECPair
  signature: string
  constructor(publickey: bitcoin.ECPair, signature: string) {
    this.publickey = publickey
    this.signature = signature
  }

  static fromAuthPart(authPart: string) {
    const decoded = JSON.parse(Buffer.from(authPart, 'base64').toString())
    const publickey = pubkeyHexToECPair(decoded.publickey)
    const signature = bitcoin.ECSignature.fromDER(
      Buffer.from(decoded.signature, 'hex'))
    return new LegacyAuthentication(publickey, signature)
  }

  static makeAuthPart(secretKey: bitcoin.ECPair, challengeText: string) {
    const publickey = secretKey.getPublicKeyBuffer().toString('hex')
    const digest = bitcoin.crypto.sha256(challengeText)
    const signature = secretKey.sign(digest).toDER().toString('hex')

    const authObj = { publickey, signature }

    return Buffer.from(JSON.stringify(authObj)).toString('base64')
  }

  isAuthenticationValid(address: string, challengeText: string,
                        options? : {}) { //  eslint-disable-line no-unused-vars
    if (this.publickey.getAddress() !== address) {
      throw new ValidationError('Address not allowed to write on this path')
    }

    const digest = bitcoin.crypto.sha256(challengeText)
    const valid = (this.publickey.verify(digest, this.signature) === true)

    if (!valid) {
      logger.debug(`Failed to validate with challenge text: ${challengeText}`)
      throw new ValidationError('Invalid signature or expired authentication token.')
    }
    return address
  }
}

export function getChallengeText(myURL: string = DEFAULT_STORAGE_URL) {
  const header = 'gaiahub'
  const dateParts = new Date().toISOString().split('T')[0]
        .split('-')
  // for right now, access tokens are valid for the calendar year.
  const allowedSpan = dateParts[0]
  const myChallenge = 'blockstack_storage_please_sign'
  return JSON.stringify( [header, allowedSpan, myURL, myChallenge] )
}

export function parseAuthHeader(authHeader: string) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer')) {
    throw new ValidationError('Failed to parse authentication header.')
  }
  const authPart = authHeader.slice('bearer '.length)
  const versionIndex = authPart.indexOf(':')
  if (versionIndex < 0) {
    // default to legacy authorization header
    return LegacyAuthentication.fromAuthPart(authPart)
  } else {
    const version = authPart.slice(0, versionIndex)
    if (version === 'v1') {
      return V1Authentication.fromAuthPart(authPart)
    } else {
      throw new ValidationError('Unknown authentication header version: ${version}')
    }
  }
}

export function validateAuthorizationHeader(authHeader: string, serverName: string,
                                            address: string, requireCorrectHubUrl?: boolean = false,
                                            validHubUrls?: ?Array<string> = null) : string {
  const serverNameHubUrl = `https://${serverName}`
  if (!validHubUrls) {
    validHubUrls = [ serverNameHubUrl ]
  } else if (validHubUrls.indexOf(serverNameHubUrl) < 0) {
    validHubUrls.push(serverNameHubUrl)
  }

  let authObject = null
  try {
    authObject = parseAuthHeader(authHeader)
  } catch (err) {
    logger.error(err)
  }

  if (!authObject) {
    throw new ValidationError('Failed to parse authentication header.')
  }

  const challengeText = getChallengeText(serverName)
  return authObject.isAuthenticationValid(address, challengeText, { validHubUrls, requireCorrectHubUrl })
}
