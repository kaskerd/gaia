/* @flow */
import fs from 'fs'
import { BadPathError } from '../errors'
import logger from 'winston'
import Path from 'path'

import type { DriverModel } from '../driverModel'
import type { Readable } from 'stream'

type DISK_CONFIG_TYPE = { diskSettings: { storageRootDirectory?: string },
                          pageSize?: number,
                          readURL?: string }

class DiskDriver implements DriverModel {
  storageRootDirectory: string
  readURL: string
  pageSize: number

  constructor (config: DISK_CONFIG_TYPE) {
    if (!config.readURL) {
      throw new Error('Config is missing readURL')
    }
    if (!config.diskSettings.storageRootDirectory) {
      throw new Error('Config is missing storageRootDirectory')
    }

    this.storageRootDirectory = config.diskSettings.storageRootDirectory
    this.readURL = config.readURL
    if (this.readURL.slice(-1) !== '/') {
      // must end in /
      this.readURL = `${this.readURL}/`
    }

    this.pageSize = config.pageSize ? config.pageSize : 100
    this.mkdirs(this.storageRootDirectory)
  }

  static isPathValid(path: string){
    if (path.indexOf('..') !== -1) {
      return false
    }
    if (path.slice(-1) === '/') {
      return false
    }
    return true
  }

  getReadURLPrefix () {
    return this.readURL
  }

  mkdirs(path: string) {
    const pathParts = path.replace(/^\//, '').split('/')
    let tmpPath = '/'
    for (let i = 0; i <= pathParts.length; i++) {
      try {
        const statInfo = fs.lstatSync(tmpPath)
        if ((statInfo.mode & fs.constants.S_IFDIR) === 0) {
          throw new Error(`Not a directory: ${tmpPath}`)
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          // need to create
          logger.debug(`mkdir ${tmpPath}`)
          fs.mkdirSync(tmpPath)
        } else {
          throw e
        }
      }
      if (i === pathParts.length) {
        break
      }
      tmpPath = `${tmpPath}/${pathParts[i]}`
    }
  }

  findAllFiles(listPath: string) : Array<string> {
    // returns a list of files prefixed by listPath
    const names = fs.readdirSync(listPath)
    const fileNames = []
    for (let i = 0; i < names.length; i++) {
      const fileOrDir = `${listPath}/${names[i]}`
      const stat = fs.statSync(fileOrDir)
      if (stat.isDirectory()) {
        const childNames = this.findAllFiles(fileOrDir)
        for (let j = 0; j < childNames.length; j++) {
          fileNames.push(childNames[j])
        }
      } else {
        fileNames.push(fileOrDir)
      }
    }
    return fileNames
  }

  listFilesInDirectory(listPath: string, pageNum: number) : Promise<{entries: Array<string>, page: ?string}> {
    const names = this.findAllFiles(listPath).map(
      (fileName) => fileName.slice(listPath.length + 1))
    return Promise.resolve().then(() => ({
      entries: names.slice(pageNum * this.pageSize, (pageNum + 1) * this.pageSize),
      page: `${pageNum + 1}`
    }))
  }

  listFiles(prefix: string, page: ?string) {
    // returns {'entries': [...], 'page': next_page}
    let pageNum
    const listPath = `${this.storageRootDirectory}/${prefix}`
    try {
      if (page) {
        if (!page.match(/^[0-9]+$/)) {
          throw new Error('Invalid page number')
        }
        pageNum = parseInt(page)
      } else {
        pageNum = 0
      }
      const stat = fs.statSync(listPath)
      if (!stat.isDirectory()) {
        throw new Error('Not a directory')
      }
    } catch(e) {
      throw new Error('Invalid arguments: invalid page or not a directory')
    }

    return this.listFilesInDirectory(listPath, pageNum)
  }

  performWrite(args: { path: string,
                       storageTopLevel: string,
                       stream: Readable,
                       contentLength: number,
                       contentType: string }) : Promise<string> {
    return Promise.resolve()
    .then(() => {
      const path = args.path
      const topLevelDir = args.storageTopLevel

      if (!topLevelDir) {
        throw new BadPathError('Invalid Path')
      }

      const abspath = Path.join(this.storageRootDirectory, topLevelDir, path)
      if (!DiskDriver.isPathValid(abspath)) {
        throw new BadPathError('Invalid Path')
      }

      // too long?
      if (abspath.length > 4096) {
        throw new BadPathError('Path is too long')
      }

      const dirparts = abspath.split('/').filter((p) => p.length > 0)

      // can't be too deep
      if (dirparts.length > 100) {
        throw new BadPathError('Path is too deep')
      }

      const absdirname = Path.dirname(abspath)
      this.mkdirs(absdirname)

      const writePipe = fs.createWriteStream(abspath, { mode: 0o600, flags: 'w' })
      args.stream.pipe(writePipe)

      return `${this.readURL}${Path.join(topLevelDir, path)}`
    })
  }
}

module.exports = DiskDriver

