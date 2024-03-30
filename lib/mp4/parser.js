'use strict';

const Utils = require('./utils');

const Movie = require('../movie');
const AudioTrack = require('../audio-track');
const VideoTrack = require('../video-track');
const AudioSample = require('../audio-sample');
const VideoSample = require('../video-sample');
const SourceReader = require('../source-reader');
const CodecParser = require('../codecs/parser');

class Parser {

    /**
     * Parse MP4 file
     * @param {(int|Buffer)} source
     * @returns {Movie}
     */
    static parse(source) {
        // Get moov atom
        let moovAtom = Parser._getMoovAtom(new SourceReader(source));
        if (!moovAtom) {
            throw new Error('MOOV atom not found');
        }

        // Create movie
        let movie = new Movie();

        // Add meta information
        let mvhdAtom = moovAtom.getAtom(Utils.ATOM_MVHD);
        if (mvhdAtom) {
            movie.timescale = mvhdAtom.timescale;
            movie.duration = mvhdAtom.duration;
        }

        // Get tracks
        let trakAtoms = moovAtom.getAtoms(Utils.ATOM_TRAK);
        for (let trakAtom of trakAtoms) {
            let mdiaAtom = trakAtom.getAtom(Utils.ATOM_MDIA);
            if (mdiaAtom !== null) {
                let hdlrAtom = mdiaAtom.getAtom(Utils.ATOM_HDLR);
                let mdhdAtom = mdiaAtom.getAtom(Utils.ATOM_MDHD);
                let minfAtom = mdiaAtom.getAtom(Utils.ATOM_MINF);
                if (hdlrAtom !== null && mdhdAtom !== null && minfAtom !== null) {
                    let stblAtom = minfAtom.getAtom(Utils.ATOM_STBL);
                    if (stblAtom !== null) {
                        let stsdAtom = stblAtom.getAtom(Utils.ATOM_STSD);
                        let track = null;
                        let samplePrototype = null;
                        let codecInfo = null;
                        switch (hdlrAtom.handlerType) {
                            case Utils.TRACK_TYPE_AUDIO: {
                                let audioAtom = stsdAtom.getAudioAtom();
                                if (audioAtom !== null) {
                                    track = new AudioTrack();
                                    samplePrototype = AudioSample.prototype;
                                    track.channels = audioAtom.channels;
                                    track.sampleRate = audioAtom.sampleRate;
                                    track.sampleSize = audioAtom.sampleSize;
                                    track.extraData = audioAtom.extraData;
                                    codecInfo = CodecParser.parse(audioAtom.extraData);
                                }
                                break;
                            }
                            case Utils.TRACK_TYPE_VIDEO: {
                                let videoAtom = stsdAtom.getVideoAtom();
                                if (videoAtom !== null) {
                                    track = new VideoTrack();
                                    samplePrototype = VideoSample.prototype;
                                    track.width = videoAtom.width;
                                    track.height = videoAtom.height;
                                    track.extraData = videoAtom.extraData;
                                    codecInfo = CodecParser.parse(videoAtom.extraData);
                                }
                                break;
                            }
                        }

                        if (track !== null) {
                            track.duration = mdhdAtom.duration;
                            track.timescale = mdhdAtom.timescale;
                            if (codecInfo !== null) {
                                track.codec = codecInfo.codec();
                            }
                            movie.addTrack(track);

                            // Get needed data to build samples
                            let compositions = [];
                            let cttsAtom = stblAtom.getAtom(Utils.ATOM_CTTS);
                            if (cttsAtom !== null) {
                                compositions = cttsAtom.entries;
                            }
                            let sampleSizes = [];
                            let stszAtom = stblAtom.getAtom(Utils.ATOM_STSZ);
                            if (stszAtom !== null) {
                                sampleSizes = stszAtom.entries;
                            }
                            let chunkOffsets = [];
                            let stcoAtom = stblAtom.getAtom(Utils.ATOM_STCO);
                            if (stcoAtom !== null) {
                                chunkOffsets = stcoAtom.entries;
                            } else {
                                let co64Atom = stblAtom.getAtom(Utils.ATOM_CO64);
                                if (co64Atom !== null) {
                                    chunkOffsets = co64Atom.entries;
                                }
                            }
                            let samplesToChunk = [];
                            let stscAtom = stblAtom.getAtom(Utils.ATOM_STSC);
                            if (stscAtom !== null) {
                                samplesToChunk = stscAtom.entries;
                            }
                            let syncSamples = [];
                            let stssAtom = stblAtom.getAtom(Utils.ATOM_STSS);
                            if (stssAtom !== null) {
                                syncSamples = stssAtom.entries;
                            }
                            let timeSamples = [];
                            let sttsAtom = stblAtom.getAtom(Utils.ATOM_STTS);
                            if (sttsAtom !== null) {
                                timeSamples = sttsAtom.entries;
                            }

                            let currentTimestamp = 0;
                            let currentChunk = 0;
                            let currentChunkOffset = 0;
                            let currentChunkNumbers = 0;
                            let currentSampleChunk = 0;
                            let index = 0;
                            let indexKeyframe = 0;
                            let samplesPerChunk = 0;
                            if (samplesToChunk.length > 0) {
                                samplesPerChunk = samplesToChunk[1];
                                currentSampleChunk = 1;
                            }

                            let sizeSamples = timeSamples.reduce((size, value, index) => {
                                if (index % 2 === 0) {
                                    size += value;
                                }
                                return size;
                            }, 0);
                            let samples = new Array(sizeSamples);
                            let pos = 0;

                            for (let i = 0, l = timeSamples.length; i < l; i += 2) {
                                let sampleDuration = timeSamples[i + 1] || 0;
                                for (let j = 0; j < timeSamples[i]; j++) {
                                    let sample = Object.create(samplePrototype);
                                    sample.timestamp = currentTimestamp;
                                    sample.timescale = track.timescale;
                                    sample.size = sampleSizes[index];
                                    sample.offset = chunkOffsets[currentChunk] + currentChunkOffset;
                                    if (track instanceof VideoTrack) {
                                        sample.compositionOffset = compositions[index] || 0;
                                        if (indexKeyframe < syncSamples.length && syncSamples[indexKeyframe] === index + 1) {
                                            sample.keyframe = true;
                                            indexKeyframe++;
                                        }
                                    }
                                    if (sample.size > 0) {
                                        samples[pos++] = sample;
                                    }

                                    currentChunkNumbers++;
                                    if (currentChunkNumbers < samplesPerChunk) {
                                        currentChunkOffset += sampleSizes[index];
                                    } else {
                                        currentChunkNumbers = 0;
                                        currentChunkOffset = 0;
                                        currentChunk++;
                                        if (currentSampleChunk * 2 + 1 < samplesToChunk.length) {
                                            if (currentChunk + 1 >= samplesToChunk[2 * currentSampleChunk]) {
                                                samplesPerChunk = samplesToChunk[2 * currentSampleChunk + 1];
                                                currentSampleChunk++;
                                            }
                                        }
                                    }

                                    currentTimestamp += sampleDuration;
                                    index++;
                                }
                            }

                            track.samples = samples.slice(0, pos);
                        }
                    }
                }
            }
        }

        // Return movie object
        return movie;
    }

    /**
     * Check MP4 file
     * @param {Buffer} buffer
     * @returns {boolean}
     * @private
     */
    static _check(buffer) {
        return buffer.readUInt32BE(0) > 0 && [Utils.ATOM_FTYP, Utils.ATOM_MOOV, Utils.ATOM_MDAT].indexOf(buffer.toString('ascii', 4, 8)) !== -1;
    }

    static _getMoovAtom(reader) {
        return (function find(offset, size) {
            let atom = Parser._readAtom(reader, offset);
            if (atom) {
                if (atom.type === Utils.ATOM_MOOV) {
                    let buffer = new Buffer(atom.size - 8);
                    if (reader.read(buffer, atom.offset + 8) === buffer.length) {
                        let moovAtom = Utils.createAtom(atom.type);
                        moovAtom.parse(buffer);
                        return moovAtom;
                    } else {
                        return null;
                    }
                } else if (offset + atom.size < size) {
                    return find(offset + atom.size, size);
                }
            }
            return null;
        })(0, reader.size());
    }

    static _readAtom(reader, offset) {
        let buffer = new Buffer(8);
        if (reader.read(buffer, offset) === buffer.length) {
            let size = buffer.readUInt32BE();
            let type = buffer.toString('ascii', 4);
            return {
                type: type,
                size: size,
                offset: offset,
            };
        }
        return null;
    }

}

module.exports = Parser;
