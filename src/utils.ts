import { S3Settings } from './settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

// Creates new attachments and replaces old links
export const migrateAttachments = async (
  body: string,
  githubRepoId: number | undefined,
  s3: S3Settings | undefined,
  gitlabHelper: GitlabHelper
) => {
  const regexp = /(!?)\[([^\]]+)\]\((\/uploads[^)]+)\)/g;

  // Maps link offset to a new name in S3
  const offsetToAttachment: {
    [key: number]: string;
  } = {};

  // Find all local links
  const matches = body.matchAll(regexp);

  for (const match of matches) {
    const prefix = match[1] || '';
    const name = match[2];
    const url = match[3];

    if (s3 && s3.bucket) {
      const basename = path.basename(url);
      const mimeType = mime.lookup(basename);
      const attachmentBuffer = await gitlabHelper.getAttachment(url);
      if (!attachmentBuffer) {
        continue;
      }

      // // Generate file name for S3 bucket from URL
      const hash = crypto.createHash('sha256');
      hash.update(url);
      const newFileName = hash.digest('hex') + '/' + basename;
      const relativePath = `${newFileName}`;

      let s3url = `${relativePath}`;

      if(s3.useS3){
        // Doesn't seem like it is easy to upload an issue to github, so upload to S3
        //https://stackoverflow.com/questions/41581151/how-to-upload-an-image-to-use-in-issue-comments-via-github-api

        s3url = `https://${s3.bucket}.s3.amazonaws.com/${relativePath}`;

        const s3bucket = new S3();
        s3bucket.createBucket(() => {
          const params: S3.PutObjectRequest = {
            Key: relativePath,
            Body: attachmentBuffer,
            ContentType: mimeType === false ? undefined : mimeType,
            Bucket: s3.bucket,
          };

          s3bucket.upload(params, function (err, data) {
            console.log(`\tUploading ${basename} to ${s3url}... `);
            if (err) {
              console.log('ERROR: ', err);
            } else {
              console.log(`\t...Done uploading`);
            }
          });
        });
      };
      if(s3.overrideURL){
        // replace the attachment URL base with the configured value
        // potentially useful if attachments are being stored in something other than S3...
        s3url = `${s3.overrideURL}/${relativePath}${s3.overrideSuffix}`;
      };
      if(s3.keepLocal){
        // keep a local copy of the attachment file
        let localFile = `attachments/${relativePath}`;
        let localFolder = path.dirname(localFile);
        fs.mkdir(localFolder, { recursive: true }, function(err){
          if(err){console.log('ERROR MSG: ', err)};
          console.log(`about to create file ${localFile}. `);
          fs.writeFile(localFile, attachmentBuffer, function(err){
            if(err){console.log('ERROR MSG: ', err)};
          });
        });
      };

      // Add the new URL to the map
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${s3url})`;
    } else {
      // Not using S3: default to old URL, adding absolute path
      const host = gitlabHelper.host.endsWith('/')
        ? gitlabHelper.host
        : gitlabHelper.host + '/';
      const attachmentUrl = host + gitlabHelper.projectPath + url;
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${attachmentUrl})`;
    }
  }

  return body.replace(
    regexp,
    ({}, {}, {}, {}, offset, {}) => offsetToAttachment[offset]
  );
};
